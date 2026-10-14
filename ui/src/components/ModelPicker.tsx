import { PROVIDER_LABELS, type KeyHint, type ModelChoice, type ModelInfo, type ProviderId } from "@mc/shared";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";

/** Pick a provider you have a key for, then a model from that provider's own list. */
export function ModelPicker(props: { current: ModelChoice | null; onChoose: (c: ModelChoice) => void; onCancel: () => void }) {
  const [keys, setKeys] = useState<KeyHint[] | null>(null);
  const [provider, setProvider] = useState<ProviderId | null>(props.current?.provider ?? null);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.keys().then(
      ({ keys }) => {
        setKeys(keys);
        setProvider((cur) => (cur && keys.some((k) => k.provider === cur) ? cur : keys[0]?.provider ?? null));
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  useEffect(() => {
    if (!provider) return;
    setModels(null);
    setError(null);
    api.models(provider).then(
      ({ models }) => setModels(models),
      (e: Error) => setError(e.message),
    );
  }, [provider]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (models ?? []).filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)).slice(0, 200);
  }, [models, query]);

  if (keys && keys.length === 0) {
    return (
      <div className="row">
        <div className="grow muted">Add an API key under API keys (bottom left) to pick a model.</div>
        <button className="btn" onClick={props.onCancel}>Close</button>
      </div>
    );
  }

  return (
    <div className="col">
      <div className="row">
        {keys?.map((k) => (
          <button key={k.provider} className={`btn ${k.provider === provider ? "primary" : ""}`} onClick={() => setProvider(k.provider)}>
            {PROVIDER_LABELS[k.provider]}
          </button>
        ))}
        <input className="input grow" placeholder="Search models" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        <button className="btn" onClick={props.onCancel}>Cancel</button>
      </div>
      {error && <div className="danger small">{error}</div>}
      {!models && !error && <div className="muted small">Loading models…</div>}
      <div className="model-list">
        {filtered.map((m) => {
          const selected = props.current?.provider === provider && props.current?.model === m.id;
          return (
            <button key={m.id} className={`model-item row ${selected ? "selected" : ""}`} onClick={() => provider && props.onChoose({ provider, model: m.id })}>
              <span className="grow truncate">{m.name}</span>
              {m.pricing && <span className="small muted">${m.pricing.input.toFixed(2)} / ${m.pricing.output.toFixed(2)} per 1M</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
