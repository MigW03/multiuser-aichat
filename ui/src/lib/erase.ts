// "Erase Nido data on this computer": only in the desktop app, which keeps the data. The app asks in a window of its own; the
// page signs the person out in between and then tells the app to go ahead.

export type EraseBridge = { confirm: () => Promise<boolean>; run: () => Promise<boolean> };

export const eraseBridge = (): EraseBridge | null => (globalThis as { desktop?: { erase?: EraseBridge } }).desktop?.erase ?? null;

/** Confirms in the app's window, signs out, erases, quits. Resolves false when the person cancelled. */
export async function eraseThisComputer(bridge: EraseBridge, signOut: () => Promise<unknown>): Promise<boolean> {
  if (!(await bridge.confirm())) return false;
  await signOut().catch(() => undefined); // revokes the session; the data folder goes either way
  return bridge.run();
}
