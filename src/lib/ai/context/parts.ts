// Model-neutral message content, stored as messages.parts.
// Kept free of database and framework imports so it can move to another runtime (e.g. a desktop app).

export type ProducedBy = { provider: string; model: string };

export type MessagePart =
  | { type: "text"; text: string; producedBy?: ProducedBy }
  | { type: "reasoning"; text: string; producedBy: ProducedBy };

export type StoredUsage = {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  /** The checkpoint the request was built on; the count is only comparable while it is still active. */
  checkpointId: string | null;
};

export function textParts(text: string, producedBy?: ProducedBy): MessagePart[] {
  return [{ type: "text", text, ...(producedBy && { producedBy }) }];
}

/** Reads stored parts, falling back to the plain content column for rows written before parts existed. */
export function partsOf(row: { parts?: unknown; content: string }): MessagePart[] {
  return Array.isArray(row.parts) ? (row.parts as MessagePart[]) : textParts(row.content);
}

/**
 * The text every model sees. Reasoning is stored (tagged with the model that produced it) but not replayed:
 * other providers reject or misread foreign reasoning, and even the same provider needs signatures we
 * don't keep yet.
 */
export function visibleText(parts: MessagePart[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
}
