import {
  modelName,
  PROVIDER_LABELS,
  REASONING_LABELS,
  REASONING_LEVELS,
  type ModelChoice,
  type ModelInfo,
  type ProviderId,
  type Reasoning,
} from "@mc/shared";
import { Brain, ChevronDown, Check, Search, Sparkles, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { useApp } from "../data.tsx";
import { fetchFavoriteModels, setFavoriteModel } from "../lib/actions.ts";
import { ICON_SM, Menu, STROKE, Spinner } from "./kit.tsx";

export const modelButtonLabel = modelName;

/** A sensible first pick for a provider: a recent mid-size model. */
export function defaultModelFor(provider: ProviderId, models: ModelInfo[]): string | null {
  const prefer: Record<ProviderId, RegExp[]> = {
    anthropic: [/sonnet/i, /opus/i, /haiku/i],
    openai: [/^gpt-\d+(\.\d+)?$/i, /^gpt-/i],
    openrouter: [/anthropic\/claude-sonnet/i, /openai\/gpt-/i],
  };
  for (const re of prefer[provider]) {
    const hit = models.find((m) => re.test(m.id));
    if (hit) return hit.id;
  }
  return models[0]?.id ?? null;
}

export function ModelPicker({ choice, onChoose, disabled }: { choice: ModelChoice | null; onChoose: (c: Pick<ModelChoice, "provider" | "model">) => void; disabled?: boolean }) {
  return (
    <Menuless>
      {({ open, toggle, close }) => (
        <>
          <button type="button" className="picker-btn" onClick={toggle} aria-haspopup="dialog" aria-expanded={open} disabled={disabled}>
            <span className="picker-icon accent" aria-hidden>
              <Sparkles size={ICON_SM} strokeWidth={STROKE} />
            </span>
            {choice ? modelButtonLabel(choice.model) : "Pick a model"}
            <ChevronDown size={ICON_SM} strokeWidth={STROKE} aria-hidden />
          </button>
          {open && (
            <ModelList
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

function ModelList({ current, onChoose }: { current: ModelChoice | null; onChoose: (c: Pick<ModelChoice, "provider" | "model">) => void }) {
  const { me, keys, openSettings } = useApp();
  const [provider, setProvider] = useState<ProviderId | null>(current?.provider ?? null);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starred, setStarred] = useState<string[]>([]);

  useEffect(() => {
    if (keys && !provider) setProvider(keys[0]?.provider ?? null);
    else if (keys && provider && !keys.some((k) => k.provider === provider)) setProvider(keys[0]?.provider ?? null);
  }, [keys, provider]);

  useEffect(() => {
    if (!provider) return;
    let live = true;
    setModels(null);
    setError(null);
    api.models(provider).then(
      ({ models: list }) => live && setModels(list),
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
    const hits = (models ?? []).filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    return { favorites: hits.filter((m) => starred.includes(m.id)), others: hits.filter((m) => !starred.includes(m.id)).slice(0, 200) };
  }, [models, query, starred]);

  const renderRow = (m: ModelInfo) => {
    const selected = current?.provider === provider && current.model === m.id;
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
    <div className="popover above end model-popover" role="dialog" aria-label="Choose a model">
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
              <button key={k.provider} type="button" role="tab" aria-selected={k.provider === provider} className={`tab ${k.provider === provider ? "on" : ""}`} onClick={() => setProvider(k.provider)}>
                {PROVIDER_LABELS[k.provider]}
              </button>
            ))}
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
            {favorites.length > 0 && (
              <>
                <div className="section-label model-group">Favorites</div>
                {favorites.map(renderRow)}
                {others.length > 0 && <div className="section-label model-group">All models</div>}
              </>
            )}
            {others.map(renderRow)}
            {models && favorites.length + others.length === 0 && <div className="popover-empty small muted">No models match.</div>}
          </div>
        </>
      )}
    </div>
  );
}

export function ReasoningPicker({ value, onChange, disabled }: { value: Reasoning; onChange: (r: Reasoning) => void; disabled?: boolean }) {
  return (
    <Menu
      label="Thinking"
      placement="above"
      align="end"
      width={140}
      items={REASONING_LEVELS.map((level) => ({ label: REASONING_LABELS[level], checked: level === value, onSelect: () => onChange(level) }))}
      trigger={({ toggle, open }) => (
        <button type="button" className="picker-btn" onClick={toggle} aria-haspopup="menu" aria-expanded={open} disabled={disabled}>
          <span className="picker-icon" aria-hidden>
            <Brain size={ICON_SM} strokeWidth={STROKE} />
          </span>
          <span className="muted">Thinking</span> {REASONING_LABELS[value]}
          <ChevronDown size={ICON_SM} strokeWidth={STROKE} aria-hidden />
        </button>
      )}
    />
  );
}
