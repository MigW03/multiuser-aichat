import { PROVIDER_IDS, PROVIDER_KEY_URLS, PROVIDER_LABELS, type ProviderId } from "@mc/shared";
import { useEffect, useState } from "react";
import { api } from "../api.ts";

type RowState = { value: string; busy: boolean; message: { text: string; error: boolean } | null };

/** API keys are sent once to the server, checked with the provider, and stored encrypted. They can't be read back. */
export function Settings() {
  const [hints, setHints] = useState<Partial<Record<ProviderId, string>>>({});
  const [rows, setRows] = useState<Record<ProviderId, RowState>>(
    () => Object.fromEntries(PROVIDER_IDS.map((p) => [p, { value: "", busy: false, message: null }])) as Record<ProviderId, RowState>,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.keys().then(
      ({ keys }) => setHints(Object.fromEntries(keys.map((k) => [k.provider, k.hint]))),
      (e: Error) => setError(e.message),
    );
  }, []);

  const update = (p: ProviderId, patch: Partial<RowState>) => setRows((r) => ({ ...r, [p]: { ...r[p], ...patch } }));

  async function save(p: ProviderId) {
    const value = rows[p].value.trim();
    if (!value) return update(p, { message: { text: "Paste a key first.", error: true } });
    update(p, { busy: true, message: null });
    try {
      const { hint } = await api.saveKey(p, value);
      setHints((h) => ({ ...h, [p]: hint }));
      update(p, { busy: false, value: "", message: { text: "Key checked and saved.", error: false } });
    } catch (e) {
      update(p, { busy: false, message: { text: (e as Error).message, error: true } });
    }
  }

  async function remove(p: ProviderId) {
    update(p, { busy: true, message: null });
    try {
      await api.deleteKey(p);
      setHints(({ [p]: _, ...rest }) => rest);
      update(p, { busy: false, message: { text: "Removed.", error: false } });
    } catch (e) {
      update(p, { busy: false, message: { text: (e as Error).message, error: true } });
    }
  }

  return (
    <div className="settings">
      <div className="title">API keys</div>
      <div className="muted">
        The AI answers your messages with your own key and the model you pick. Keys are stored encrypted on the server and can't be
        read back, not even by you.
      </div>
      {error && <div className="danger">{error}</div>}
      {PROVIDER_IDS.map((p) => (
        <div key={p} className="card col">
          <div className="row">
            <div className="subtitle grow">{PROVIDER_LABELS[p]}</div>
            <div className="small muted">{hints[p] ? `Saved key …${hints[p]}` : "No key saved"}</div>
          </div>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void save(p);
            }}
          >
            <input
              className="input grow"
              type="password"
              autoComplete="off"
              placeholder={`Paste your ${PROVIDER_LABELS[p]} API key`}
              value={rows[p].value}
              onChange={(e) => update(p, { value: e.target.value })}
            />
            <button className="btn primary" disabled={rows[p].busy}>{rows[p].busy ? "Checking…" : "Save"}</button>
            {hints[p] && (
              <button type="button" className="btn" disabled={rows[p].busy} onClick={() => void remove(p)}>Remove</button>
            )}
          </form>
          <div className="row small">
            <div className={`grow ${rows[p].message?.error ? "danger" : "success"}`}>{rows[p].message?.text}</div>
            <a className="btn link" href={PROVIDER_KEY_URLS[p]} target="_blank" rel="noreferrer">Get a key</a>
          </div>
        </div>
      ))}
    </div>
  );
}
