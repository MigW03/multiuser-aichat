import { faviconHref } from "./logo.ts";

/** Points the page's SVG favicon at the mark in this accent, so the tab icon follows an accent change. */
export function setFavicon(accent: string, doc: Document | undefined = typeof document === "undefined" ? undefined : document) {
  if (!doc) return;
  let link = doc.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
  if (!link) {
    link = doc.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    doc.head.appendChild(link);
  }
  link.href = faviconHref(accent);
}
