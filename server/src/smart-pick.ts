import { cheapest, DECISIONS_URL, decisionRequest, extractChoice, smartOptions, type PickInput } from "./smart-rules.ts";
import type { ModelInfo } from "@mc/shared";

// Asks Jev (through OpenRouter, with the person's own key) which model of their Smart set should answer. Whatever goes
// wrong, the answer is still a model from the set: the cheapest one, flagged as a fallback.

// The reply waits for this choice, so it must be quick: a slow classifier costs more than a cheaper model's worse answer.
const TIMEOUT_MS = 3_000;

/** `why` is a short reason when the choice could not be made, shown under the answer to help find the cause. `ms` is how long the choice took. */
export type Pick = { model: string; fallback: boolean; why?: string; ms?: number };

/** `fetchImpl` is only swapped in tests. The key is sent to OpenRouter and nowhere else, and is never logged. */
export async function pickSmartModel(args: { apiKey: string; models: string[]; info: ModelInfo[]; signal?: AbortSignal; fetchImpl?: typeof fetch } & PickInput): Promise<Pick> {
  const started = Date.now();
  const options = smartOptions(args.models, args.info, args.pictures, args.tools === true);
  const fallback = (why: string, detail = ""): Pick => {
    console.error(`[smart] using the cheapest model of the set: ${why}${detail ? ` (${detail})` : ""}`);
    return { model: cheapest(options).id, fallback: true, why, ms: Date.now() - started };
  };
  if (options.length === 1) return { model: options[0]!.id, fallback: false, ms: 0 };
  try {
    const res = await (args.fetchImpl ?? fetch)(DECISIONS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${args.apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(decisionRequest(options, args)),
      signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(args.signal ? [args.signal] : [])]),
    });
    if (!res.ok) return fallback(`HTTP ${res.status}`);
    const json: unknown = await res.json().catch(() => null);
    const chosen = extractChoice(json, options);
    // Only the shape of an unreadable answer is logged: it holds no message text, but the key names help to fix the parser.
    return chosen ? { model: chosen.id, fallback: false, ms: Date.now() - started } : fallback("unreadable answer", JSON.stringify(json)?.slice(0, 300));
  } catch (e) {
    return fallback(e instanceof Error && e.name === "TimeoutError" ? "timed out" : "request failed");
  }
}
