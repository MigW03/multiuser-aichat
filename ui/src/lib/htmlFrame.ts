import DOMPurify from "dompurify";

// The Preview of an HTML file. The file is untrusted (a teammate wrote it, the AI wrote it, it came from a download), so it
// is never shown in the app's own page. Three walls, any one of which would already keep it from running code or reaching out:
//   1. the text is cleaned here: scripts, forms, frames, <meta> (refresh!), <link>, <base>, event attributes and link targets go;
//   2. a Content-Security-Policy in the page itself allows inline styles and pictures that are part of the file, nothing else;
//   3. the frame that shows it has an empty `sandbox` (see FRAME_SANDBOX): no scripts, no same origin, no forms, no popups.
// The result is the file's own look, static.

/** The frame's `sandbox` attribute. Empty on purpose: every permission is off. Do not add "allow-scripts" or "allow-same-origin". */
export const FRAME_SANDBOX = "";

export const FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

type Purifier = Pick<typeof DOMPurify, "sanitize" | "addHook" | "removeHook">;

const FORBIDDEN_TAGS = ["script", "noscript", "form", "input", "button", "select", "textarea", "option", "iframe", "frame", "frameset", "object", "embed", "applet", "audio", "video", "source", "track", "link", "meta", "base", "template", "dialog"];
const FORBIDDEN_ATTRS = ["srcset", "ping", "formaction", "action", "target", "rel"];

// Links stay as text with their look; they point nowhere. Pictures keep only an inline (data:) source.
function hook(node: Element) {
  const tag = node.nodeName.toLowerCase();
  if (tag === "a" || tag === "area") {
    node.removeAttribute("href");
    node.removeAttribute("xlink:href");
  }
  if (node.hasAttribute("src") && !/^data:image\//i.test(node.getAttribute("src") ?? "")) node.removeAttribute("src");
  const href = node.getAttribute("xlink:href") ?? node.getAttribute("href");
  if (href !== null && tag !== "a" && !/^#/.test(href)) {
    node.removeAttribute("xlink:href");
    node.removeAttribute("href");
  }
}

/**
 * The page to put in the frame's `srcdoc` for the text of an HTML file. `purify` is DOMPurify bound to a window (the default
 * one is the browser's).
 */
export function frameDocument(text: string, purify: Purifier = DOMPurify): string {
  purify.addHook("afterSanitizeAttributes", hook);
  try {
    const clean = purify.sanitize(text, {
      WHOLE_DOCUMENT: true,
      FORBID_TAGS: FORBIDDEN_TAGS,
      FORBID_ATTR: FORBIDDEN_ATTRS,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: true,
      RETURN_TRUSTED_TYPE: false,
    }) as string;
    // The policy comes first in the page so that it covers everything after it. A doctype before it keeps the page out of quirks mode.
    const body = clean.replace(/^\s*<!doctype[^>]*>/i, "");
    return `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><meta name="color-scheme" content="light"><base target="_blank">${body}`;
  } finally {
    purify.removeHook("afterSanitizeAttributes", hook);
  }
}
