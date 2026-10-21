import assert from "node:assert/strict";
import { test } from "node:test";

const key = (init: Partial<KeyboardEvent>) => init as KeyboardEvent;

test("new chat shortcut: Cmd+Shift+O on a Mac, Ctrl+Shift+O elsewhere; Cmd+N only in the desktop app", async () => {
  // navigator is read once at import, so each platform gets a fresh copy of the module.
  const load = async (platform: string, desktop: boolean) => {
    Object.defineProperty(globalThis, "navigator", { value: { platform, userAgent: platform }, configurable: true });
    (globalThis as { desktop?: unknown }).desktop = desktop ? {} : undefined;
    return (await import(`./shortcuts.ts?${platform}${desktop}`)) as typeof import("./shortcuts.ts");
  };

  const web = await load("MacIntel", false);
  assert.equal(web.NEW_CHAT_SHORTCUT.matches(key({ code: "KeyO", metaKey: true, shiftKey: true })), true);
  assert.equal(web.NEW_CHAT_SHORTCUT.matches(key({ code: "KeyN", metaKey: true })), false);
  assert.equal(web.NEW_CHAT_SHORTCUT.matches(key({ code: "KeyO", ctrlKey: true, shiftKey: true })), false);
  assert.equal(web.NEW_CHAT_SHORTCUT.label, "⌘⇧O");

  const mac = await load("MacIntel", true);
  assert.equal(mac.NEW_CHAT_SHORTCUT.matches(key({ code: "KeyN", metaKey: true })), true);
  assert.equal(mac.NEW_CHAT_SHORTCUT.matches(key({ code: "KeyN", metaKey: true, shiftKey: true })), false);
  assert.equal(mac.NEW_CHAT_SHORTCUT.matches(key({ code: "KeyN", metaKey: true, altKey: true })), false);
  assert.equal(mac.NEW_CHAT_SHORTCUT.label, "⌘N");

  const win = await load("Win32", true);
  assert.equal(win.NEW_CHAT_SHORTCUT.matches(key({ code: "KeyN", ctrlKey: true })), true);
  assert.equal(win.NEW_CHAT_SHORTCUT.matches(key({ code: "KeyN", metaKey: true })), false);
});
