import type { AllowedCommand, FolderAuto, ProjectSummary } from "@mc/shared";
import { ArrowLeft, PanelLeftOpen } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { folderBridge, useAllowedCommands, useLocalFolder } from "../lib/folder.ts";
import { closeProjectSettings } from "../lib/router.ts";
import { PANEL_SHORTCUT } from "../lib/shortcuts.ts";
import { notifySupabaseChanged, useSupabaseState } from "../lib/supabaseState.ts";
import { notifyVercelChanged, useVercelState } from "../lib/vercelState.ts";
import { ConfirmDialog } from "./Dialogs.tsx";
import { LinkSupabaseDialog, linkText, supabaseDashboardUrl } from "./SupabaseUi.tsx";
import { LinkVercelDialog, linkText as vercelLinkText, vercelDashboardUrl } from "./VercelUi.tsx";
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

type CapSwitch = {
  key: "edit" | "git" | "exec";
  /** Turned on in a window the desktop app shows itself (the page cannot click it), so no confirmation here. */
  native?: boolean;
  title: string;
  text: string;
  /** The question asked before turning it on. */
  confirmTitle: string;
  confirmText: (project: string) => string;
};

const SWITCHES: Record<CapSwitch["key"], CapSwitch> = {
  edit: {
    key: "edit",
    title: "Let the AI propose file changes",
    text: "Off by default. When on, the AI in this project's chats can propose edits to the files you share. You see every change as a diff and, unless you choose otherwise below, nothing is written until you approve it in the desktop app.",
    confirmTitle: "Let the AI propose changes?",
    confirmText: (project) =>
      `In ${project}'s chats, the AI will be able to propose edits to the files you share, asked for by anyone in the project. Each proposal appears in this app as a diff. Nothing is written until you click Approve, and secrets like .env files and keys stay off limits. You can switch this off any time.`,
  },
  git: {
    key: "git",
    title: "Let the AI use git",
    text: "Off by default. When on, the AI and the project's members can see the git status, diffs and history of the folders you share. The AI can propose to stage files, commit, restore files and create a branch; you approve each one in the desktop app. It cannot push or pull.",
    confirmTitle: "Let the AI use git?",
    confirmText: (project) =>
      `In ${project}'s chats, the AI will be able to read the git status, diffs and history of the files you share (hidden files like .env are left out, secrets are masked), and members will see changes in the shared folder card. The AI can propose git add, commit, restore and a new branch. Each proposal shows the exact command and what it changes, and nothing runs until you click Approve. Git runs with hooks, filters and your git config switched off, and never pushes. You can switch this off any time.`,
  },
  exec: {
    key: "exec",
    native: true,
    title: "Let the AI propose commands",
    text: "Off by default. When on, the AI can propose shell commands (tests, builds). Each one appears in the desktop app with the exact text; you approve it and confirm it in a second window before it runs. Nothing else runs on its own, unless you choose to let safe commands through below, or tick “always allow” for a plain command in that window: then that exact command, in that folder, runs without asking for 30 days, until you revoke it below. There is no sandbox: an approved command can read or change anything you can.",
    confirmTitle: "",
    confirmText: () => "",
  },
};

/** One switch for the files this person shares. It lives on their computer, so only their desktop app can change it. */
function CapSetting({ project, which }: { project: ProjectSummary; which: CapSwitch }) {
  const bridge = folderBridge();
  const local = useLocalFolder(project.id);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = typeof bridge?.setCaps === "function";
  const on = local?.caps?.[which.key] === true;

  // Why the switch can't be used here, if it can't.
  const note =
    !bridge || !supported
      ? "This is set in the desktop app, on the computer that shares the files."
      : !local?.linked
        ? "Share files from this computer first (Files card, right column)."
        : null;

  async function set(next: boolean) {
    setError(null);
    try {
      await bridge?.setCaps?.(project.id, { [which.key]: next });
      setConfirm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change this.");
    }
  }

  return (
    <>
      <SettingRow
        title={which.title}
        text={which.text}
        note={note}
        control={
          <input
            type="checkbox"
            className="setting-switch"
            role="switch"
            aria-label={which.title}
            checked={on}
            disabled={note !== null}
            onChange={(e) => (e.target.checked && !which.native ? setConfirm(true) : void set(e.target.checked))}
          />
        }
      />
      {error && <ErrorLine>{error}</ErrorLine>}
      {confirm && (
        <Dialog title={which.confirmTitle} onClose={() => setConfirm(false)}>
          <p className="lead">{which.confirmText(project.name)}</p>
          <div className="dialog-actions">
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void set(true)}>
              Allow
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

type AutoChoice = {
  key: keyof FolderAuto;
  title: string;
  ask: string;
  free: string;
  /** What the "free" choice does and does not cover, shown under the choice. */
  detail: ReactNode;
};

const CHOICES: Record<keyof FolderAuto, AutoChoice> = {
  edit: {
    key: "edit",
    title: "When the AI changes a file",
    ask: "Ask me first",
    free: "Save it, ask only for risky ones",
    detail: (
      <>
        Edits to existing files and new files in the shared folder are saved at once, and everyone sees the diff in chat. It still asks before replacing a whole file, changing a file that runs code (package.json, scripts, CI, Dockerfile, hooks, anything executable) or making a large change. Secrets, .env files and keys stay off limits. There is no undo here: use git.
      </>
    ),
  },
  exec: {
    key: "exec",
    title: "When the AI wants to run a command",
    ask: "Ask me for each",
    free: "Run safe ones, ask for the rest",
    detail: (
      <>
        Runs without asking: <code>pwd</code>, <code>ls</code> inside the shared folder, and the project's own checks: <code>npm test</code>, <code>npm run lint</code>, <code>typecheck</code>, <code>check</code> or <code>build</code> (and the pnpm and yarn forms) when package.json has that script. Everything else asks, as before. There is no sandbox: a test or build runs the project's code. After the AI saves files without asking, the next check asks once, and your approval clears that.
      </>
    ),
  },
};

/** The "ask or let safe things through" choice under a switch. Turning it on asks in a window the app shows; the page cannot click it. */
function AutoSetting({ project, which }: { project: ProjectSummary; which: keyof FolderAuto }) {
  const bridge = folderBridge();
  const local = useLocalFolder(project.id);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const c = CHOICES[which];
  if (!bridge || typeof bridge.setAuto !== "function" || local?.caps?.[which] !== true) return null;
  const free = local.auto?.[which] === true;

  async function set(next: boolean) {
    setError(null);
    try {
      await bridge?.setAuto?.(project.id, { [which]: next });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change this.");
    }
  }

  return (
    <div className="setting-row auto-setting">
      <div className="grow">
        <div className="strong">{c.title}</div>
        <div className="segmented" role="radiogroup" aria-label={c.title}>
          {[false, true].map((v) => (
            <button key={String(v)} type="button" role="radio" aria-checked={free === v} className={`seg ${free === v ? "on" : ""}`} onClick={() => free !== v && void set(v)}>
              {v ? c.free : c.ask}
            </button>
          ))}
        </div>
        <p className="small muted">
          <button type="button" className="link-button" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide" : "What this covers"}
          </button>
        </p>
        {open && <p className="small muted">{c.detail}</p>}
        {error && <ErrorLine>{error}</ErrorLine>}
      </div>
    </div>
  );
}

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The commands this person chose to always allow in this project, each with Revoke. They are added only in the desktop app's own confirmation window. */
function AlwaysAllowed({ project }: { project: ProjectSummary }) {
  const { rules, revoke, revokeAll } = useAllowedCommands(project.id);
  const local = useLocalFolder(project.id);
  if (rules === null) return null;
  const off = local?.caps?.exec !== true;
  return (
    <div className="setting-row always-allowed">
      <div className="grow">
        <div className="strong">Always-allowed commands</div>
        <p className="small muted">
          These run without asking, only with exactly this text and only in the folder shown. {off ? "They are paused while commands are switched off. " : ""}You add one by ticking the box in the confirm window; each lasts 30 days.
        </p>
        {rules.length === 0 ? (
          <p className="small muted">Nothing is always allowed.</p>
        ) : (
          <>
            <ul className="allowed-list">
              {rules.map((r: AllowedCommand) => (
                <li key={r.id}>
                  <div className="grow">
                    <code className="truncate">{r.command}</code>
                    <div className="small muted">
                      {r.folder || "shared folder"} · added {day(r.createdAt)} · {r.lastRunAt ? `last run ${day(r.lastRunAt)}` : "never run"} · expires {day(r.expiresAt)}
                    </div>
                  </div>
                  <Button size="sm" onClick={() => void revoke(r.id)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
            {rules.length > 1 && (
              <Button size="sm" onClick={() => void revokeAll()}>
                Revoke all
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The Supabase project linked to this one. Linking adds the Supabase tab to the Files card for everyone in the project; what each person sees inside comes from their own Supabase account. */
function SupabaseSetting({ project }: { project: ProjectSummary }) {
  const sup = useSupabaseState(project.id);
  const [dialog, setDialog] = useState<"link" | "change" | "setup" | null>(null);
  const [unlink, setUnlink] = useState(false);
  const state = sup.state;
  const title = "Supabase";

  if (!state) {
    return <SettingRow title={title} text={sup.failed ? "Could not load this. Reload the page to try again." : "Loading…"} control={null} />;
  }
  const close = () => setDialog(null);
  const dialogs = (
    <>
      {dialog && <LinkSupabaseDialog project={project} sup={sup} mode={dialog} onClose={close} />}
      {unlink && (
        <ConfirmDialog
          title="Unlink Supabase?"
          confirmLabel="Unlink"
          danger
          onClose={() => setUnlink(false)}
          onConfirm={async () => {
            await api.supabaseUnlink(project.id);
            notifySupabaseChanged();
          }}
        >
          <p>The Supabase tab goes away for everyone in {project.name}. Nothing in Supabase changes.</p>
        </ConfirmDialog>
      )}
    </>
  );

  if (!state.link) {
    return (
      <>
        <SettingRow
          title={title}
          text="Not linked. Link a Supabase project to see its tables, checks and logs in the Files card. Read-only."
          note={state.canLink ? null : "The host or an admin links it."}
          control={
            state.canLink ? (
              <Button size="sm" variant="primary" onClick={() => setDialog("link")}>
                Link project…
              </Button>
            ) : null
          }
        />
        {dialogs}
      </>
    );
  }

  const none = state.mine.state === "none";
  return (
    <>
      <SettingRow
        title={title}
        text={`Linked to ${linkText(state.link)}. Everyone in ${project.name} sees the Supabase tab once they have Supabase set up. What they see inside comes from their own Supabase account.`}
        note={none ? "You have not set up Supabase yet, so you don't see the tab." : null}
        control={
          <span className="setting-actions">
            {none && (
              <Button size="sm" variant="primary" onClick={() => setDialog("setup")}>
                Set up Supabase
              </Button>
            )}
            {state.canLink && (
              <>
                <Button size="sm" onClick={() => setDialog("change")}>
                  Change…
                </Button>
                <Button size="sm" onClick={() => setUnlink(true)}>
                  Unlink…
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={() => window.open(supabaseDashboardUrl(state.link!.ref), "_blank", "noopener,noreferrer")}>
              Open in Supabase ↗
            </Button>
          </span>
        }
      />
      {dialogs}
    </>
  );
}

/** The Vercel project linked to this one. Linking adds the Vercel tab to the Files card for everyone in the project; what each person sees inside comes from their own Vercel account. */
function VercelSetting({ project }: { project: ProjectSummary }) {
  const sup = useVercelState(project.id);
  const [dialog, setDialog] = useState<"link" | "change" | "setup" | null>(null);
  const [unlink, setUnlink] = useState(false);
  const state = sup.state;
  const title = "Vercel";

  if (!state) {
    return <SettingRow title={title} text={sup.failed ? "Could not load this. Reload the page to try again." : "Loading…"} control={null} />;
  }
  const close = () => setDialog(null);
  const dialogs = (
    <>
      {dialog && <LinkVercelDialog project={project} vh={sup} mode={dialog} onClose={close} />}
      {unlink && (
        <ConfirmDialog
          title="Unlink Vercel?"
          confirmLabel="Unlink"
          danger
          onClose={() => setUnlink(false)}
          onConfirm={async () => {
            await api.vercelUnlink(project.id);
            notifyVercelChanged();
          }}
        >
          <p>The Vercel tab goes away for everyone in {project.name}. Nothing in Vercel changes.</p>
        </ConfirmDialog>
      )}
    </>
  );

  if (!state.link) {
    return (
      <>
        <SettingRow
          title={title}
          text="Not linked. Link a Vercel project to see its deployments, errors, domains and variable names in the Files card. Read-only."
          note={state.canLink ? null : "The host or an admin links it."}
          control={
            state.canLink ? (
              <Button size="sm" variant="primary" onClick={() => setDialog("link")}>
                Link project…
              </Button>
            ) : null
          }
        />
        {dialogs}
      </>
    );
  }

  const none = state.mine.state === "none";
  return (
    <>
      <SettingRow
        title={title}
        text={`Linked to ${vercelLinkText(state.link)}. Everyone in ${project.name} sees the Vercel tab once they have Vercel set up. What they see inside comes from their own Vercel account.`}
        note={none ? "You have not set up Vercel yet, so you don't see the tab." : null}
        control={
          <span className="setting-actions">
            {none && (
              <Button size="sm" variant="primary" onClick={() => setDialog("setup")}>
                Set up Vercel
              </Button>
            )}
            {state.canLink && (
              <>
                <Button size="sm" onClick={() => setDialog("change")}>
                  Change…
                </Button>
                <Button size="sm" onClick={() => setUnlink(true)}>
                  Unlink…
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={() => window.open(vercelDashboardUrl(state.link!), "_blank", "noopener,noreferrer")}>
              Open in Vercel ↗
            </Button>
          </span>
        }
      />
      {dialogs}
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
          <SettingsSection title="AI and the files you share">
            <CapSetting project={project} which={SWITCHES.edit} />
            <AutoSetting project={project} which="edit" />
            <CapSetting project={project} which={SWITCHES.git} />
            <CapSetting project={project} which={SWITCHES.exec} />
            <AutoSetting project={project} which="exec" />
            <AlwaysAllowed project={project} />
          </SettingsSection>
          <SettingsSection title="Connected services">
            <SupabaseSetting project={project} />
            <VercelSetting project={project} />
          </SettingsSection>
        </div>
      </div>
    </section>
  );
}
