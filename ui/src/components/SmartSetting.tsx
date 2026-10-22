import { DEFAULT_REASONING, isSmartModel, LIMITS, PROVIDER_BILLING_URLS, SMART_MODEL_ID, type SmartKeyStatus } from "@mc/shared";
import { useState } from "react";
import { api, ApiRequestError } from "../api.ts";
import { useApp } from "../data.tsx";
import { loadModels } from "../lib/models.ts";
import { Button, ErrorLine } from "./kit.tsx";
import { defaultModelFor } from "./Pickers.tsx";
import { smartChanged, useSmart } from "./useSmart.ts";

const PROBLEMS: Record<Exclude<SmartKeyStatus, "ok">, string> = {
  no_key: "Add your OpenRouter API key above to use this.",
  invalid_key: "OpenRouter rejected your key. Replace it above to use this.",
  no_credits: "Your OpenRouter key has no credits left.",
  unreachable: "Could not reach OpenRouter to check your key. Try again in a moment.",
};

/** Settings > AI key: this person's own switch for letting Auto choose the model that answers them. It needs their OpenRouter key. */
export function SmartSetting() {
  const { keys, choice, setChoice } = useApp();
  const smart = useSmart();
  const hasKey = !!keys?.some((k) => k.provider === "openrouter");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Exclude<SmartKeyStatus, "ok"> | null>(null);
  const [keyOk, setKeyOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const { key } = await api.smart(true);
      setProblem(key && key !== "ok" ? key : null);
      setKeyOk(key === "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check your key.");
    } finally {
      setBusy(false);
    }
  }

  async function set(next: boolean) {
    setBusy(true);
    setError(null);
    setProblem(null);
    setKeyOk(false);
    try {
      await api.setSmart(next);
      smartChanged();
      if (next) {
        setKeyOk(true);
        // Switched on with a big enough set: start using Auto right away.
        if (smart.models.length >= LIMITS.smartMin) setChoice({ provider: "openrouter", model: SMART_MODEL_ID, reasoning: choice?.reasoning ?? DEFAULT_REASONING });
      } else if (isSmartModel(choice?.model)) {
        // Auto no longer works: go back to an ordinary model.
        const model = defaultModelFor("openrouter", await loadModels("openrouter").catch(() => []));
        if (model) setChoice({ provider: "openrouter", model, reasoning: choice?.reasoning ?? DEFAULT_REASONING });
      }
    } catch (e) {
      const code = e instanceof ApiRequestError ? e.code : undefined;
      const status = code?.startsWith("smart_") ? (code.slice(6) as SmartKeyStatus) : null;
      if (status && status !== "ok" && status in PROBLEMS) setProblem(status);
      else setError(e instanceof Error ? e.message : "Could not change this.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-label="Smart model selection">
      <h2>Smart model selection</h2>
      <div className="settings-rows">
        <div className="setting-row">
          <div className="grow">
            <div className="strong">Let Auto choose the model</div>
            <p className="small muted">
              Off by default. When on, the model picker gets a Smart selector tab: you pick a set of models, and before each of your messages Jev, a small classifier model on OpenRouter, chooses one of them. It can only choose from your set, and each answer shows the model that wrote it. It uses your OpenRouter key and credits, in every chat.
            </p>
            {!hasKey && <p className="small setting-note">Add your OpenRouter API key above to use this.</p>}
            {smart.enabled && (
              <p className="small muted">
                Your Smart set: {smart.models.length} {smart.models.length === 1 ? "model" : "models"}.{" "}
                {smart.models.length < LIMITS.smartMin ? `Add at least ${LIMITS.smartMin} in the model picker, under Smart selector.` : "Change it in the model picker, under Smart selector."}
              </p>
            )}
          </div>
          <input type="checkbox" className="setting-switch" role="switch" aria-label="Smart model selection" checked={smart.enabled} disabled={busy || !smart.loaded || !hasKey} onChange={(e) => void set(e.target.checked)} />
        </div>
        {problem && (
          <ErrorLine>
            {PROBLEMS[problem]}{" "}
            {problem === "no_credits" && (
              <a className="btn sm" href={PROVIDER_BILLING_URLS.openrouter} target="_blank" rel="noreferrer">
                Add credits
              </a>
            )}{" "}
            <Button size="sm" busy={busy} onClick={() => void check()}>
              Check again
            </Button>
          </ErrorLine>
        )}
        {error && <ErrorLine>{error}</ErrorLine>}
        {smart.enabled && !problem && (
          <div className="setting-row">
            <div className="grow small muted">{keyOk ? "OpenRouter key checked. OpenRouter shows a key's credits only in some cases, so one that ran out is caught when a message is sent." : "OpenRouter shows a key's credits only in some cases, so one that ran out is caught when a message is sent."}</div>
            <Button size="sm" busy={busy} onClick={() => void check()}>
              Check my key
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
