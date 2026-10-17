// Heuristics for text that looks like a credential, so the composer can warn before it goes to everyone in the chat
// (and to the AI provider). A warning, never a block: false positives only cost a click.

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "API key", re: /\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}/ },
  { name: "API key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "API key", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{30,}/ },
  { name: "API key", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "API key", re: /\b(?:AIza)[A-Za-z0-9_-]{35}\b/ },
  { name: "access token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "private key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: "password", re: /\b(?:password|passwd|pwd|passcode)\s*(?:is|=|:)\s*\S{4,}/i },
  { name: "secret", re: /\b(?:api[_ -]?key|secret|token)\s*(?:is|=|:)\s*['"]?[A-Za-z0-9_\-./+=]{16,}/i },
];

/** What the text looks like ("API key", "password", ...) and the matching snippet, or null. */
export function findSecret(text: string): { kind: string; match: string } | null {
  for (const { name, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) return { kind: name, match: m[0] };
  }
  return null;
}

/** "sk-ant-api03-Zr8…" shown as "sk-ant-api03-••••••••" */
export function maskSecret(match: string): string {
  const keep = Math.min(12, Math.floor(match.length / 3));
  return `${match.slice(0, keep)}${"•".repeat(16)}`;
}
