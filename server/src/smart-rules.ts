import { isSmartModel, LIMITS, type ModelInfo, type OpenRouterUsage } from "@mc/shared";

// The rules of Smart model selection that need no database or network, so they can be tested alone.

/** A Smart set as it may be saved: valid model ids, no repeats, never the router itself. Null when something is off. */
export function cleanSmartSet(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length > LIMITS.smartMax) return null;
  const out: string[] = [];
  for (const m of input) {
    if (typeof m !== "string" || !LIMITS.modelIdPattern.test(m) || isSmartModel(m)) return null;
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * What a key's usage numbers say about credit. A normal OpenRouter key can only see its own spending cap, so "no credits" is
 * claimed only when OpenRouter shows zero left (the cap, or the account balance when it may be read). Otherwise it is
 * "ok", and a key that really is empty is caught when OpenRouter refuses the request (402).
 */
export function creditStatus(usage: Pick<OpenRouterUsage, "budget" | "credits">): "ok" | "no_credits" {
  if (usage.budget && usage.budget.remaining !== null && usage.budget.remaining <= 0) return "no_credits";
  if (usage.credits && usage.credits.total - usage.credits.used <= 0) return "no_credits";
  return "ok";
}

// ---- Picking the model for Auto. OpenRouter hosts Jev, TypeSafe's classifier model, behind a "decisions" endpoint. Jev is
// asked one multiple choice question: which of the person's own models should answer this message. It can only answer with
// one of the options it is given, so the answer is always a model from the person's Smart set.

export const JEV_MODEL = "typesafe/jev-1.13";
export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
/** The id of the one question asked. */
export const QUESTION_ID = "pick";

export const SMART_INSTRUCTIONS = [
  "Choose which AI model should answer the latest message in this chat.",
  "Pick the cheapest option that can answer it well.",
  "Use a cheap, fast option for greetings, short factual questions, casual chat, simple rewrites and short summaries.",
  "Use a stronger, more expensive option only for hard work: multi-step reasoning, math, careful analysis, long or complex code, difficult writing, or many constraints.",
  "If the latest message has pictures, pick an option that can look at pictures.",
  "If the latest message asks to make or change a design, mockup, wireframe, screen, files or code, or to use connected tools, the answer has to call tools correctly over several steps: pick a capable option that can call tools, not a small or cheap one.",
  "Judge by the latest message. The recent messages are only context.",
].join(" ");

/** One model of the person's set, as Jev sees it. `key` is what Jev answers with; it never contains the model id. */
export type SmartOption = { key: string; id: string; name: string; price: { input: number; output: number } | null; vision: boolean | undefined; tools?: boolean | undefined };

/**
 * The options for a set, in the order the person listed them. With pictures, models known not to see them are left out; when the
 * answer is offered tools, models known not to call them are left out (each unless that leaves none).
 */
export function smartOptions(models: string[], info: ModelInfo[], pictures: boolean, tools = false): SmartOption[] {
  const all = models.map((id, i): SmartOption => {
    const m = info.find((x) => x.id === id);
    return { key: `m${i + 1}`, id, name: m?.name ?? id, price: m?.pricing ?? null, vision: m?.vision, tools: m?.tools };
  });
  const seeing = pictures ? all.filter((o) => o.vision !== false) : all;
  const usable = seeing.length > 0 ? seeing : all;
  const calling = tools ? usable.filter((o) => o.tools !== false) : usable;
  return calling.length > 0 ? calling : usable;
}

const cost = (o: SmartOption) => (o.price ? o.price.output + o.price.input / 4 : Number.POSITIVE_INFINITY);

/** The cheapest option (by price; one with no known price counts as the dearest). With no prices at all, the first. */
export function cheapest(options: SmartOption[]): SmartOption {
  return options.reduce((best, o) => (cost(o) < cost(best) ? o : best));
}

const usd = (n: number) => (n >= 1 ? n.toFixed(2) : n.toFixed(3)).replace(/0+$/, "").replace(/\.$/, "");

/** What Jev is told about one option: the model, its price, how it ranks on price in the set, and whether it sees pictures. */
export function describeOption(o: SmartOption, options: SmartOption[]): string {
  const priced = options.filter((x) => x.price).sort((a, b) => cost(a) - cost(b));
  const rank = priced.indexOf(o);
  const tier = !o.price || priced.length < 2 ? "price unknown" : rank === 0 ? "the cheapest option" : rank === priced.length - 1 ? "the most expensive option" : "a middle option on price";
  const price = o.price ? `$${usd(o.price.input)} input and $${usd(o.price.output)} output per million tokens` : "price unknown";
  return `${o.name} (${o.id}). ${price}; ${tier}. ${o.vision === true ? "Can look at pictures." : o.vision === false ? "Cannot look at pictures." : "Picture support unknown."}${o.tools === true ? " Can call tools." : o.tools === false ? " Cannot call tools." : ""}`;
}

/** `tools`: the answer is offered tools (a project chat's notes and designs, a shared folder, connected tools). */
export type PickInput = { latest: string; context: { from: "person" | "ai"; text: string }[]; pictures: boolean; tools?: boolean };

const LATEST_CHARS = 4000;
const CONTEXT_MESSAGES = 6;
const CONTEXT_CHARS = 400;

/** The request body for the decisions endpoint. */
export function decisionRequest(options: SmartOption[], input: PickInput) {
  return {
    model: JEV_MODEL,
    state: {
      latest_message: input.latest.slice(0, LATEST_CHARS),
      latest_message_has_pictures: input.pictures,
      answer_can_use_tools: input.tools === true,
      recent_messages: input.context.slice(-CONTEXT_MESSAGES).map((m) => ({ from: m.from, text: m.text.slice(0, CONTEXT_CHARS) })),
    },
    questions: {
      [QUESTION_ID]: {
        type: "choice",
        instructions: SMART_INSTRUCTIONS,
        criteria: Object.fromEntries(options.map((o) => [o.key, describeOption(o, options)])),
      },
    },
  };
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Which option Jev chose. The answer is read from where a choice answer is documented to be (keyed by the question id, naming
 * the option), tolerating a plain string or a wrapper object. Anything that is not exactly one of the options gives null.
 */
export function extractChoice(json: unknown, options: SmartOption[]): SmartOption | null {
  const root = obj(json);
  const answers = obj(root.answers ?? root.results ?? root);
  const answer = answers[QUESTION_ID] ?? root[QUESTION_ID];
  const a = obj(answer);
  const named = typeof answer === "string" ? answer : [a.choice, a.value, a.answer, a.selected, a.option, a.label].find((v): v is string => typeof v === "string");
  if (!named) return null;
  const want = named.trim().toLowerCase();
  return options.find((o) => o.key.toLowerCase() === want) ?? null;
}
