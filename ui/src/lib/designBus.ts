// How the design panel (beside the chat, outside it) sends a message in the chat that is open: "Build in code" and
// "Update code" are ordinary chat messages, so everyone in the chat sees them and the AI answers as usual.

type Sender = (content: string) => Promise<boolean>;
let sender: Sender | null = null;

/** The open chat registers how to send; the returned function unregisters it. */
export function setChatSender(next: Sender): () => void {
  sender = next;
  return () => {
    if (sender === next) sender = null;
  };
}

/** Sends in the open chat. False when no chat is open or sending failed. */
export function sendInOpenChat(content: string): Promise<boolean> {
  return sender ? sender(content) : Promise.resolve(false);
}

export const hasOpenChat = () => sender !== null;

/** Puts the cursor in the open chat's message box. */
export function focusComposer() {
  document.querySelector<HTMLTextAreaElement>(".composer-input textarea")?.focus();
}

// An answer that saved a design tells the open canvas, in case the realtime hint was missed (the canvas re-reads the file).
type Listener = (path: string) => void;
const listeners = new Set<Listener>();

export function onDesignChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function designChanged(path: string) {
  for (const fn of listeners) fn(path);
}

// An answer in the open chat finished (done, failed or stopped): a canvas the AI locked for it unlocks.
type RunListener = (chatId: string) => void;
const runListeners = new Set<RunListener>();

export function onDesignRunEnded(fn: RunListener): () => void {
  runListeners.add(fn);
  return () => void runListeners.delete(fn);
}

export function designRunEnded(chatId: string) {
  for (const fn of runListeners) fn(chatId);
}
