import { LIMITS } from "@mc/shared";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { findSecret, maskSecret } from "../lib/secrets.ts";
import { SecretWarning } from "./Dialogs.tsx";
import { editState } from "../lib/messageEdit.ts";
import { MarkdownBackdrop } from "./MarkdownBackdrop.tsx";
import { Button } from "./kit.tsx";

type Props = {
  /** The words as they are now (no design marker, no picture placeholder). */
  initial: string;
  /** The message has pictures: they stay, so the words may be emptied. */
  hasPictures: boolean;
  /** An AI reply follows this message: "Save and write the reply again" is offered. */
  hasReply: boolean;
  /** No connection: saving would fail. */
  offline: boolean;
  onCancel: () => void;
  /** Resolves when saved; rejects with the reason it was not (the text stays for another try). */
  onSave: (text: string, regenerate: boolean) => Promise<void>;
};

/** Edit a message in place: the same live-Markdown box as the composer, with Cancel (Esc), Save (Enter) and, when an AI reply follows, Save and regenerate. */
export function MessageEditor({ initial, hasPictures, hasReply, offline, onCancel, onSave }: Props) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState<null | "save" | "regenerate">(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [warning, setWarning] = useState<{ kind: string; snippet: string; regenerate: boolean } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const state = editState(text, initial, hasPictures);
  const canSave = state.canSave && !offline && !saving;

  // Open with the caret at the end, and grow with the text.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
    syncBackdrop();
  }, [text]);

  function syncBackdrop() {
    if (backdrop.current && ref.current) backdrop.current.style.transform = `translateY(${-ref.current.scrollTop}px)`;
  }

  async function save(regenerate: boolean, skipSecretCheck = false) {
    if (!canSave) return;
    if (!skipSecretCheck) {
      const secret = findSecret(state.text);
      if (secret) return setWarning({ kind: secret.kind, snippet: maskSecret(secret.match), regenerate });
    }
    setWarning(null);
    setFailed(null);
    setSaving(regenerate ? "regenerate" : "save");
    try {
      await onSave(state.text, regenerate);
    } catch (e) {
      setFailed(e instanceof Error && e.message ? e.message : "Not saved.");
      setSaving(null);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!saving) onCancel();
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void save(false);
    }
  }

  return (
    <div className="msg-edit" role="group" aria-label="Edit message">
      <div className="msg-edit-input">
        <textarea
          ref={ref}
          className="md-live"
          rows={1}
          value={text}
          maxLength={LIMITS.messageChars}
          aria-label="Edit your message"
          disabled={saving !== null}
          onChange={(e) => {
            setText(e.target.value);
            setFailed(null);
          }}
          onKeyDown={onKeyDown}
          onScroll={syncBackdrop}
        />
        <MarkdownBackdrop text={text} innerRef={backdrop} />
      </div>
      <div className="msg-edit-bar">
        <span className="msg-edit-note small">
          {failed ? (
            <span className="danger-text" role="alert">
              Not saved. {failed === "Not saved." ? "" : `${failed} `}
              <button type="button" className="link-btn" onClick={() => void save(false)}>
                Retry
              </button>
            </span>
          ) : offline ? (
            <span className="muted">You are offline. Save is off until you are back.</span>
          ) : (
            <span className="muted kbd-hint">Esc to cancel · Enter to save</span>
          )}
        </span>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving !== null}>
          Cancel
        </Button>
        {hasReply && (
          <Button size="sm" onClick={() => void save(true)} disabled={!canSave} busy={saving === "regenerate"} title="Save, then the AI answers this message again and replaces its old reply">
            Save &amp; regenerate AI reply
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => void save(false)} disabled={!canSave} busy={saving === "save"}>
          Save
        </Button>
      </div>
      {warning && <SecretWarning kind={warning.kind} snippet={warning.snippet} onEdit={() => setWarning(null)} onSendAnyway={() => void save(warning.regenerate, true)} />}
    </div>
  );
}
