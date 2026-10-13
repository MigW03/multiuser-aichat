"use client";

import { useEffect, useRef, useState } from "react";
import { PROVIDER_LABELS, type ProviderId } from "@/lib/ai/provider-meta";

export type ModelChoice = { provider: ProviderId; model: string };
type ModelInfo = { id: string; name: string; pricing?: { input: number; output: number } };

const MAX_VISIBLE = 100;

// USD per 1M tokens, trimmed: 3 -> "3", 0.15 -> "0.15", 18.75 -> "18.75".
const money = (n: number) => `$${Number(n < 1 ? n.toFixed(3) : n.toFixed(2))}`;
function priceLine(p: ModelInfo["pricing"]) {
  if (!p) return null;
  if (p.input === 0 && p.output === 0) return "Free";
  return `${money(p.input)} in · ${money(p.output)} out`;
}
const cache = new Map<ProviderId, ModelInfo[]>(); // per browser tab; a reload refreshes it

function ModelRow(props: {
  info: ModelInfo;
  provider: ProviderId;
  selected: boolean;
  starred: boolean;
  onPick: () => void;
  onStar: () => void;
}) {
  const { info, starred } = props;
  return (
    <div
      className={`group flex items-center rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-900 ${
        props.selected ? "bg-neutral-100 dark:bg-neutral-900" : ""
      }`}
    >
      <button
        type="button"
        onClick={props.onPick}
        aria-current={props.selected}
        title={info.id}
        className="flex min-w-0 flex-1 flex-col px-2 py-1.5 text-left text-sm"
      >
        <span className="truncate dark:group-hover:text-white">{info.name}</span>
        <span className="truncate text-xs text-neutral-500">
          {priceLine(info.pricing) ?? `Check pricing at ${PROVIDER_LABELS[props.provider]}`}
        </span>
      </button>
      <button
        type="button"
        onClick={props.onStar}
        aria-pressed={starred}
        aria-label={starred ? `Remove ${info.name} from favorites` : `Add ${info.name} to favorites`}
        title={starred ? "Remove from favorites" : "Add to favorites"}
        className={`px-2 py-1.5 text-base leading-none ${starred ? "text-amber-500" : "text-neutral-400 hover:text-amber-500"}`}
      >
        {starred ? "★" : "☆"}
      </button>
    </div>
  );
}

export function ModelPicker(props: {
  providers: ProviderId[];
  value: ModelChoice | null;
  onChange: (choice: ModelChoice) => void;
  favorites: ModelChoice[];
  onToggleFavorite: (choice: ModelChoice) => void;
}) {
  const { providers, value, favorites } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ProviderId>(value?.provider ?? providers[0]);
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState<Partial<Record<ProviderId, ModelInfo[]>>>({});
  const [errors, setErrors] = useState<Partial<Record<ProviderId, string>>>({});
  const [attempt, setAttempt] = useState(0);
  const models = loaded[active] ?? cache.get(active) ?? null;
  const error = errors[active] ?? null;
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || cache.has(active)) return;
    fetch(`/api/models?provider=${active}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "Could not load models.");
        return data.models as ModelInfo[];
      })
      .then((list) => {
        cache.set(active, list);
        setLoaded((l) => ({ ...l, [active]: list }));
      })
      .catch((e: Error) => setErrors((x) => ({ ...x, [active]: e.message })));
  }, [open, active, attempt]);

  function toggle() {
    if (!open) {
      setActive(value && providers.includes(value.provider) ? value.provider : providers[0]);
      setQuery("");
      setErrors({}); // reopening retries a failed load
    }
    setOpen(!open);
  }

  function pick(model: string) {
    props.onChange({ provider: active, model });
    setOpen(false);
  }

  const q = query.trim().toLowerCase();
  const matchesQuery = (m: ModelInfo) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
  const starredIds = new Set(favorites.filter((f) => f.provider === active).map((f) => f.model));
  // Favorites keep the order they were starred in. One that's missing from the provider's list (retired, or typed
  // in by hand) still shows, by its id.
  const favoriteRows = [...starredIds]
    .map((id) => models?.find((m) => m.id === id) ?? { id, name: id })
    .filter(matchesQuery);
  const otherRows = (models ?? []).filter((m) => !starredIds.has(m.id) && matchesQuery(m));
  const exact = (models ?? []).some((m) => m.id === query.trim()) || starredIds.has(query.trim());

  const row = (m: ModelInfo) => (
    <ModelRow
      key={m.id}
      info={m}
      provider={active}
      selected={value?.provider === active && value.model === m.id}
      starred={starredIds.has(m.id)}
      onPick={() => pick(m.id)}
      onStar={() => props.onToggleFavorite({ provider: active, model: m.id })}
    />
  );

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
        title={value ? `${PROVIDER_LABELS[value.provider]} · ${value.model}` : "Choose a model"}
        className={`flex max-w-56 items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${
          value ? "border-neutral-300 dark:border-neutral-700" : "border-amber-500"
        }`}
      >
        <span className="truncate">{value ? value.model : "Choose a model"}</span>
        <span aria-hidden className="text-neutral-500">
          ▾
        </span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-10 mb-2 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border border-neutral-200 bg-background p-2 text-sm shadow-lg dark:border-neutral-800">
          {providers.length > 1 && (
            <div className="flex gap-1">
              {providers.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setActive(p);
                    setQuery("");
                  }}
                  className={`flex-1 rounded-md px-2 py-1 ${
                    p === active ? "bg-foreground text-background" : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
                  }`}
                >
                  {PROVIDER_LABELS[p]}
                </button>
              ))}
            </div>
          )}
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${PROVIDER_LABELS[active]} models`}
            aria-label="Search models"
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
          />
          {models?.some((m) => m.pricing) && (
            <p className="px-1 text-xs text-neutral-500">Prices are USD per 1M tokens.</p>
          )}
          <div className="flex max-h-64 flex-col overflow-y-auto">
            {error ? (
              <div className="flex flex-col gap-2 p-2">
                <p className="text-red-600">{error}</p>
                <button
                  type="button"
                  className="self-start underline"
                  onClick={() => {
                    setErrors((x) => ({ ...x, [active]: undefined }));
                    setAttempt((n) => n + 1);
                  }}
                >
                  Try again
                </button>
              </div>
            ) : models === null ? (
              <p className="p-2 text-neutral-500">Loading models…</p>
            ) : (
              <>
                {favoriteRows.length > 0 && (
                  <>
                    <p className="px-2 pb-1 pt-0.5 text-xs font-medium text-neutral-500">Favorites</p>
                    {favoriteRows.map(row)}
                    {otherRows.length > 0 && <p className="px-2 pb-1 pt-2 text-xs font-medium text-neutral-500">All models</p>}
                  </>
                )}
                {otherRows.slice(0, MAX_VISIBLE).map(row)}
                {otherRows.length > MAX_VISIBLE && (
                  <p className="p-2 text-xs text-neutral-500">
                    Showing {MAX_VISIBLE} of {otherRows.length}. Keep typing to narrow it down.
                  </p>
                )}
                {query.trim() && !exact && (
                  <button
                    type="button"
                    onClick={() => pick(query.trim())}
                    className="rounded-md px-2 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
                  >
                    Use &ldquo;{query.trim()}&rdquo;
                  </button>
                )}
                {!favoriteRows.length && !otherRows.length && !query.trim() && (
                  <p className="p-2 text-neutral-500">No models found.</p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
