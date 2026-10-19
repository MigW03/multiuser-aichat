import type { ProjectSummary } from "@mc/shared";
import { ArrowLeft, PanelLeftOpen, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import { folderBridge, useLocalFolder } from "../lib/folder.ts";
import { closeProjectSettings } from "../lib/router.ts";
import { PANEL_SHORTCUT } from "../lib/shortcuts.ts";
import { Button, Dialog, ErrorLine, ICON, ICON_SM, IconButton, STROKE } from "./kit.tsx";
import { RightPanelToggle } from "./FolderUi.tsx";

// The project's settings, in place of the chat (project menu > Project settings). Add a setting by adding a
// <SettingRow> to a <SettingsSection>; a new group of settings is a new <SettingsSection>.

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section" aria-label={title}>
      <h2>{title}</h2>
      <div className="settings-rows">{children}</div>
    </section>
  );
}

function SettingRow({ title, text, note, control }: { title: string; text: string; note?: ReactNode; control: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="grow">
        <div className="strong">{title}</div>
        <p className="small muted">{text}</p>
        {note && <p className="small setting-note">{note}</p>}
      </div>
      {control}
    </div>
  );
}

/** Whether the AI may propose changes to the shared files. Lives on the host's computer, so only the host's desktop app can change it. */
function AiChangesSetting({ project }: { project: ProjectSummary }) {
  const host = project.my_role === "host";
  const bridge = folderBridge();
  const local = useLocalFolder(host ? project.id : null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = typeof bridge?.setCaps === "function";
  const on = local?.caps?.edit === true;

  // Why the switch can't be used here, if it can't.
  const note = !host
    ? "Only the project host can change this."
    : !bridge || !supported
      ? "This is set in the desktop app, on the computer that shares the files."
      : !local?.linked
        ? "Share files from this computer first (shared files card, right column)."
        : null;

  async function set(next: boolean) {
    setError(null);
    try {
      await bridge?.setCaps?.(project.id, { edit: next });
      setConfirm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change this.");
    }
  }

  return (
    <>
      <SettingRow
        title="Let the AI propose file changes"
        text="Off by default. When on, the AI in this project's chats can propose edits to the shared files. You see every change as a diff and nothing is written until you approve it in the desktop app."
        note={note}
        control={
          <input
            type="checkbox"
            className="setting-switch"
            role="switch"
            aria-label="Let the AI propose file changes"
            checked={on}
            disabled={note !== null}
            onChange={(e) => (e.target.checked ? setConfirm(true) : void set(false))}
          />
        }
      />
      {error && <ErrorLine>{error}</ErrorLine>}
      {confirm && (
        <Dialog title="Let the AI propose changes?" onClose={() => setConfirm(false)}>
          <p className="lead">
            In {project.name}'s chats, the AI will be able to propose edits to the files you share, asked for by anyone in the project. Each proposal appears in this app as a diff. Nothing is written until you click Approve, and secrets like .env files and keys stay off limits. You can switch this off any time.
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void set(true)}>
              Allow proposals
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

export function ProjectSettings({ project, leftCollapsed, onShowLeft }: { project: ProjectSummary; leftCollapsed: boolean; onShowLeft: () => void }) {
  return (
    <section className="chat-card project-settings" aria-label="Project settings">
      <header className="chat-header">
        {leftCollapsed && (
          <IconButton label="Show chats" shortcut={PANEL_SHORTCUT} onClick={onShowLeft}>
            <PanelLeftOpen size={ICON} strokeWidth={STROKE} />
          </IconButton>
        )}
        <Button variant="ghost" size="sm" onClick={() => closeProjectSettings(project.id)}>
          <ArrowLeft size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Back to chat
        </Button>
        <div className="chat-title">
          <h1 className="truncate">Project settings</h1>
          <span className="small muted truncate">{project.name}</span>
        </div>
        <div className="grow" />
        <RightPanelToggle />
      </header>
      <div className="settings-body">
        <div className="settings-col">
          <SettingsSection title="AI and files">
            <AiChangesSetting project={project} />
          </SettingsSection>
        </div>
      </div>
    </section>
  );
}
