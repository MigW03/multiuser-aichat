import {
  FALLBACK_REASONING,
  isSmartModel,
  LIMITS,
  modelName,
  PROVIDER_LABELS,
  REASONING_LABELS,
  SMART_MODEL_ID,
  type ModelChoice,
  type ModelInfo,
  type ProviderId,
  type Reasoning,
} from "@mc/shared";
import { Brain, ChevronDown, Check, Pin, Plus, Search, Sparkles, Star, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadModels } from "../lib/models.ts";
import { useApp } from "../data.tsx";
import { fetchFavoriteModels, setFavoriteModel } from "../lib/actions.ts";
import { ICON_SM, Menu, Popover, STROKE, Spinner } from "./kit.tsx";
import { useSmart } from "./useSmart.ts";

export const modelButtonLabel = modelName;

/** A sensible first pick for a provider: a recent mid-size model. */
export function defaultModelFor(provider: ProviderId, models: ModelInfo[]): string | null {
  const prefer: Record<ProviderId, RegExp[]> = {
    anthropic: [/sonnet/i, /opus/i, /haiku/i],
    openai: [/^gpt-\d+(\.\d+)?$/i, /^gpt-/i],
    openrouter: [/anthropic\/claude-sonnet/i, /openai\/gpt-/i],
    chatgpt: [], // the account's own list is already best first
  };
  for (const re of prefer[provider]) {
    const hit = models.find((m) => re.test(m.id));
    if (hit) return hit.id;
  }
  return models[0]?.id ?? null;
}

const AUTO: Pick<ModelChoice, "provider" | "model"> = { provider: "openrouter", model: SMART_MODEL_ID };

export function ModelPicker({ choice, onChoose, disabled }: { choice: ModelChoice | null; onChoose: (c: Pick<ModelChoice, "provider" | "model">) => void; disabled?: boolean }) {
  const smart = useSmart();
  const auto = !!choice && choice.provider === "openrouter" && isSmartModel(choice.model);
  // With Smart model selection on, picking a model yourself pins it until you go back to Auto.
  const pinned = smart.enabled && !!choice && !auto;
  return (
    <Menuless>
      {({ open, toggle, close }) => (
        <>
          <button type="button" className="picker-btn" onClick={toggle} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} title={pinned ? "This model is pinned. Smart model selection is paused until you go back to Auto." : undefined}>
            <span className="picker-icon accent" aria-hidden>
              {pinned ? <Pin size={ICON_SM} strokeWidth={STROKE} /> : <Sparkles size={ICON_SM} strokeWidth={STROKE} />}
            </span>
            {choice ? modelButtonLabel(choice.model) : "Pick a model"}
            <ChevronDown size={ICON_SM} strokeWidth={STROKE} aria-hidden />
          </button>
          {pinned && smart.ready && (
            <button type="button" className="picker-btn" onClick={() => onChoose(AUTO)} title="Let Smart model selection choose the model again">
              <span className="picker-icon accent" aria-hidden>
                <Sparkles size={ICON_SM} strokeWidth={STROKE} />
              </span>
              Back to Auto
            </button>
          )}
          {open && (
            <ModelList
              smart={smart}
              current={choice}
              onChoose={(c) => {
                onChoose(c);
                close();
              }}
            />
          )}
        </>
      )}
    </Menuless>
  );
}

/** A relatively-positioned wrapper that closes its panel on outside click and Escape. */
function Menuless({ children }: { children: (s: { open: boolean; toggle: () => void; close: () => void }) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      {children({ open, toggle: () => setOpen((o) => !o), close: () => setOpen(false) })}
    </div>
  );
}

type Tab = ProviderId | "smart";

function ModelList({ current, onChoose, smart }: { current: ModelChoice | null; onChoose: (c: Pick<ModelChoice, "provider" | "model">) => void; smart: ReturnType<typeof useSmart> }) {
  const { me, keys, openSettings } = useApp();
  const [tab, setTab] = useState<Tab | null>(smart.enabled && isSmartModel(current?.model) ? "smart" : (current?.provider ?? null));
  // The Smart selector lists OpenRouter's models, so it loads (and stars) them like the OpenRouter tab does.
  const provider: ProviderId | null = tab === "smart" ? "openrouter" : tab;
  const setProvider = (p: Tab | null) => setTab(p);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starred, setStarred] = useState<string[]>([]);

  useEffect(() => {
    if (keys && !tab) setProvider(keys[0]?.provider ?? null);
    else if (keys && tab && tab !== "smart" && !keys.some((k) => k.provider === tab)) setProvider(keys[0]?.provider ?? null);
    else if (tab === "smart" && !smart.enabled) setProvider(keys?.[0]?.provider ?? null);
  }, [keys, tab, smart.enabled]);

  useEffect(() => {
    if (!provider) return;
    let live = true;
    setModels(null);
    setError(null);
    loadModels(provider).then(
      (list) => live && setModels(list),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [provider]);

  useEffect(() => {
    if (!provider) return;
    let live = true;
    setStarred([]);
    fetchFavoriteModels(me.id, provider).then(
      (list) => live && setStarred(list),
      () => {}, // stars are a convenience; the list still works without them
    );
    return () => {
      live = false;
    };
  }, [provider, me.id]);

  const toggleStar = (model: string) => {
    if (!provider) return;
    const on = !starred.includes(model);
    setStarred((s) => (on ? [...s, model] : s.filter((x) => x !== model)));
    void setFavoriteModel(me.id, provider, model, on).then((ok) => {
      if (!ok) setStarred((s) => (on ? s.filter((x) => x !== model) : [...s, model])); // roll back
    });
  };

  const { favorites, others } = useMemo(() => {
    const q = query.trim().toLowerCase();
    // The router itself is not a model to pick: Auto (Smart selector tab) is how it is used.
    const hits = (models ?? []).filter((m) => m.id !== SMART_MODEL_ID && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)));
    return { favorites: hits.filter((m) => starred.includes(m.id)), others: hits.filter((m) => !starred.includes(m.id)).slice(0, 200) };
  }, [models, query, starred]);

  const renderRow = (m: ModelInfo) => {
    const selected = tab !== "smart" && current?.provider === provider && current.model === m.id;
    const isStarred = starred.includes(m.id);
    return (
      <div key={m.id} className="model-row">
        <button type="button" role="option" aria-selected={selected} className={`model-item ${selected ? "selected" : ""}`} onClick={() => provider && onChoose({ provider, model: m.id })}>
          <span className="grow truncate">{m.name}</span>
          {m.pricing && <span className="small muted">${m.pricing.input.toFixed(2)} / ${m.pricing.output.toFixed(2)}</span>}
          {selected && <Check size={ICON_SM} strokeWidth={2} aria-hidden />}
        </button>
        <button type="button" className={`icon-btn star-btn ${isStarred ? "on" : ""}`} aria-pressed={isStarred} aria-label={`${isStarred ? "Unstar" : "Star"} ${m.name}`} onClick={() => toggleStar(m.id)}>
          <Star size={ICON_SM} strokeWidth={STROKE} fill={isStarred ? "currentColor" : "none"} aria-hidden />
        </button>
      </div>
    );
  };

  return (
    <Popover label="Choose a model" className="model-popover">
      {keys && keys.length === 0 ? (
        <div className="popover-empty">
          <p className="small muted">Add an AI key to choose a model.</p>
          <button type="button" className="btn primary sm" onClick={() => openSettings("key")}>
            Add a key
          </button>
        </div>
      ) : (
        <>
          <div className="tabs" role="tablist">
            {keys?.map((k) => (
              <button key={k.provider} type="button" role="tab" aria-selected={k.provider === tab} className={`tab ${k.provider === tab ? "on" : ""}`} onClick={() => setProvider(k.provider)}>
                {PROVIDER_LABELS[k.provider]}
              </button>
            ))}
            {smart.enabled && (
              <button type="button" role="tab" aria-selected={tab === "smart"} className={`tab ${tab === "smart" ? "on" : ""}`} onClick={() => setProvider("smart")}>
                Smart selector
              </button>
            )}
          </div>
          <label className="search-field small">
            <Search size={ICON_SM} strokeWidth={STROKE} aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models" aria-label="Search models" data-autofocus autoFocus />
          </label>
          {error && <div className="error-line pad">{error}</div>}
          {!models && !error && (
            <div className="popover-empty">
              <Spinner />
            </div>
          )}
          <div className="model-list" role="listbox" aria-label="Models">
            {tab === "smart" ? (
              <SmartTab smart={smart} auto={isSmartModel(current?.model)} models={models ?? []} candidates={[...favorites, ...others]} searching={query.trim() !== ""} onAuto={() => onChoose(AUTO)} />
            ) : (
              <>
                {favorites.length > 0 && (
                  <>
                    <div className="section-label model-group">Favorites</div>
                    {favorites.map(renderRow)}
                    {others.length > 0 && <div className="section-label model-group">All models</div>}
                  </>
                )}
                {others.map(renderRow)}
                {models && favorites.length + others.length === 0 && <div className="popover-empty small muted">No models match.</div>}
              </>
            )}
          </div>
        </>
      )}
    </Popover>
  );
}

/**
 * The Smart selector tab: Auto, and this person's set of models for it. The router picks only from the set, so it has to
 * hold at least LIMITS.smartMin. The search box above filters the models offered for adding.
 */
function SmartTab({ smart, auto, models, candidates, searching, onAuto }: { smart: ReturnType<typeof useSmart>; auto: boolean; models: ModelInfo[]; candidates: ModelInfo[]; searching: boolean; onAuto: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const info = (id: string) => models.find((m) => m.id === id);
  const full = smart.models.length >= LIMITS.smartMax;
  const save = (next: string[]) => {
    setError(null);
    smart.setModels(next).catch((e: Error) => setError(e.message));
  };
  const price = (m: ModelInfo | undefined) => m?.pricing && <span className="small muted">${m.pricing.input.toFixed(2)} / ${m.pricing.output.toFixed(2)}</span>;
  return (
    <>
      <button type="button" role="option" aria-selected={auto} disabled={!smart.ready} className={`model-item ${auto ? "selected" : ""}`} onClick={onAuto}>
        <Sparkles size={ICON_SM} strokeWidth={STROKE} aria-hidden />
        <span className="grow truncate">
          Auto <span className="small muted">chooses a model from your set for each message</span>
        </span>
        {auto && <Check size={ICON_SM} strokeWidth={2} aria-hidden />}
      </button>
      {!smart.ready && <div className="small muted pad">Add at least {LIMITS.smartMin} models to your set to use Auto.</div>}
      {error && <div className="error-line pad">{error}</div>}
      <div className="section-label model-group">Your Smart set ({smart.models.length})</div>
      {smart.models.length === 0 && <div className="small muted pad">Nothing yet. A cheap, fast model and a stronger one is a good start.</div>}
      {smart.models.map((id) => (
        <div key={id} className="model-row">
          <div className="model-item">
            <span className="grow truncate">{info(id)?.name ?? id}</span>
            {price(info(id))}
          </div>
          <button type="button" className="icon-btn" aria-label={`Remove ${info(id)?.name ?? id} from your set`} onClick={() => save(smart.models.filter((m) => m !== id))}>
            <X size={ICON_SM} strokeWidth={STROKE} aria-hidden />
          </button>
        </div>
      ))}
      <div className="section-label model-group">{searching ? "Matching models" : "Add models"}</div>
      {full && <div className="small muted pad">Your set is full ({LIMITS.smartMax} models). Remove one to add another.</div>}
      {candidates
        .filter((m) => !smart.models.includes(m.id))
        .map((m) => (
          <div key={m.id} className="model-row">
            <div className="model-item">
              <span className="grow truncate">{m.name}</span>
              {price(m)}
            </div>
            <button type="button" className="icon-btn" disabled={full} aria-label={`Add ${m.name} to your set`} onClick={() => save([...smart.models, m.id])}>
              <Plus size={ICON_SM} strokeWidth={STROKE} aria-hidden />
            </button>
          </div>
        ))}
    </>
  );
}

/** Thinking levels the chosen model accepts. `levels` null: not known yet, so the common ones are offered. */
export function ReasoningPicker({ levels, value, onChange, disabled, auto }: { levels: Reasoning[] | null; value: Reasoning | null; onChange: (r: Reasoning) => void; disabled?: boolean; /** Auto is the model choice: the router sets the thinking level too. */ auto?: boolean }) {
  const offered = levels ?? FALLBACK_REASONING;
  const none = levels !== null && levels.length === 0;
  return (
    <Menu
      label="Thinking"
      placement="above"
      align="end"
      width={150}
      items={offered.map((level) => ({ label: REASONING_LABELS[level], checked: level === value, onSelect: () => onChange(level) }))}
      trigger={({ toggle, open }) => (
        <button type="button" className="picker-btn" onClick={toggle} aria-haspopup="menu" aria-expanded={open} disabled={disabled || none || auto} title={auto ? "Auto sets the thinking level for each message" : none ? "This model does not offer thinking levels" : undefined}>
          <span className="picker-icon" aria-hidden>
            <Brain size={ICON_SM} strokeWidth={STROKE} />
          </span>
          <span className="muted">Thinking</span> {auto ? "Auto" : none || !value ? "Not available" : REASONING_LABELS[value]}
          <ChevronDown size={ICON_SM} strokeWidth={STROKE} aria-hidden />
        </button>
      )}
    />
  );
}
