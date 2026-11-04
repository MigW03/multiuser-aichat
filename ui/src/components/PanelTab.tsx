import { PANEL_ICONS, PANEL_LIMITS, PANEL_REPLACES_LABEL, type PanelFull, type PanelIcon, type ProjectSummary } from "@mc/shared";
import { Ellipsis, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { draftInOpenChat } from "../lib/drafts.ts";
import { PANEL_ICON_VIEWS } from "../lib/panelIcons.tsx";
import { panelsBridge, type PanelResult } from "../lib/panels.ts";
import { Button, Dialog, ErrorLine, Field, ICON_SM, IconButton, Menu, Spinner, STROKE, TextInput, useToast, type MenuItem } from "./kit.tsx";
import { PanelBody } from "./PanelBody.tsx";
import { Details } from "./PanelDraftCards.tsx";

// One custom panel, as the tab of the Files card shows it: Nido's own header (name, "On this computer", refresh, the "..." menu)
// around the body the AI's wireframe describes. The header and menu are Nido's; the AI cannot change them. Everything here works
// on this computer's own copy: the panel never reaches the chat server.

const ago = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** What the person types into the chat box to start a panel. It sends nothing. */
export const NEW_PANEL_STARTER = "Make me a panel that shows ";

/** Puts text in the open chat's message box, or says why not. */
export function startInChat(text: string, toast: ReturnType<typeof useToast>) {
  if (!draftInOpenChat(text)) toast.push("Open a chat first, then ask the AI there.", "info");
}

export function PanelTab({ project, panelId, count, index, onGone }: { project: ProjectSummary; panelId: string; count: number; index: number; /** The panel no longer exists (deleted here or elsewhere). */ onGone: () => void }) {
  const toast = useToast();
  const bridge = panelsBridge();
  const [full, setFull] = useState<PanelFull | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [token, setToken] = useState(0);
  const [dialog, setDialog] = useState<"rename" | "icon" | "details" | null>(null);

  const load = useCallback(async () => {
    if (!bridge) return;
    const r = await bridge.get(project.id, panelId).catch(() => null);
    if (!r) return setProblem("This panel couldn't be read.");
    if (r.ok) {
      setFull(r.value);
      setProblem(null);
    } else {
      setFull(null);
      setProblem(r.error);
    }
  }, [bridge, project.id, panelId]);

  useEffect(() => {
    setFull(null);
    setProblem(null);
    void load();
    return bridge?.onChange((id) => id === project.id && void load());
  }, [bridge, project.id, panelId, load]);

  if (!bridge) return null;

  const run = async <T,>(job: Promise<PanelResult<T>>, done?: (value: T) => void) => {
    const r = await job.catch(() => null);
    if (!r) return toast.push("That didn't work on this computer.", "error");
    if (!r.ok) return toast.push(r.error, "error");
    done?.(r.value);
  };
  const remove = () =>
    void run(bridge.delete(project.id, panelId), (deleted) => {
      if (deleted) {
        toast.push(`“${full?.meta.name ?? "Panel"}” deleted`, "info");
        onGone();
      }
    });

  if (problem && !full) {
    return (
      <div className="side-card-body folder-empty-body">
        <div className="strong">This panel can't be opened</div>
        <p className="small muted">{problem}</p>
        <Button size="sm" onClick={remove}>
          Delete…
        </Button>
      </div>
    );
  }
  if (!full) return <div className="side-card-body folder-empty-body"><Spinner /></div>;

  const { meta } = full;
  const items: MenuItem[] = [
    { label: "Change with AI", onSelect: () => startInChat(`About my “${meta.name}” panel: `, toast) },
    { label: "Details (data & functions)", onSelect: () => setDialog("details") },
    { label: "Rename…", onSelect: () => setDialog("rename") },
    { label: "Icon…", onSelect: () => setDialog("icon") },
    { label: "Move left", disabled: index === 0, onSelect: () => void run(bridge.move(project.id, panelId, -1)) },
    { label: "Move right", disabled: index >= count - 1, onSelect: () => void run(bridge.move(project.id, panelId, 1)) },
    { label: "Undo last change", disabled: !full.hasPrev, onSelect: () => void run(bridge.undo(project.id, panelId), () => toast.push("Went back one version", "info")) },
    { label: "Clear saved data…", onSelect: () => void run(bridge.clearState(project.id, panelId), (done) => done && setToken((n) => n + 1)) },
    "divider",
    ...(meta.replaces ? [{ label: `Switch back to Nido's ${PANEL_REPLACES_LABEL[meta.replaces]} tab…`, onSelect: remove }] : []),
    { label: "Delete panel…", danger: true, onSelect: remove },
  ];

  return (
    <div className="side-card-body panel-tab">
      <div className="panel-tab-head">
        <strong className="grow panel-tab-name">{meta.name}</strong>
        <span className="chip" title={meta.replaces ? `Stands in for Nido's ${PANEL_REPLACES_LABEL[meta.replaces]} tab. Stored only on this computer.` : "Stored only on this computer"}>{meta.replaces ? `Replaces ${PANEL_REPLACES_LABEL[meta.replaces]}` : "On this computer"}</span>
        <IconButton label="Refresh" className="sm" onClick={() => setToken((n) => n + 1)}>
          <RotateCw size={ICON_SM} strokeWidth={STROKE} />
        </IconButton>
        <Menu
          label={`${meta.name} menu`}
          align="end"
          items={items}
          trigger={({ toggle, open }) => (
            <IconButton label="More" className="sm" onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
              <Ellipsis size={ICON_SM} strokeWidth={STROKE} />
            </IconButton>
          )}
        />
      </div>
      <PanelBody projectId={project.id} panel={full} refreshToken={token} />
      <div className="panel-tab-foot small muted">Made by AI · v{meta.rev} · {ago(meta.updatedAt)}</div>
      {dialog === "details" && (
        <Dialog title={`${meta.name} · data & functions`} onClose={() => setDialog(null)} width={420} footer={<Button onClick={() => setDialog(null)}>Close</Button>}>
          <Details shape={{ name: meta.name, icon: meta.icon, view: full.view, sources: meta.sources, functions: meta.functions }} />
        </Dialog>
      )}
      {dialog === "rename" && <RenameDialog name={meta.name} onClose={() => setDialog(null)} onSave={(name) => bridge.rename(project.id, panelId, name)} />}
      {dialog === "icon" && <IconDialog current={meta.icon} onClose={() => setDialog(null)} onPick={(icon) => bridge.setIcon(project.id, panelId, icon)} />}
    </div>
  );
}

function RenameDialog({ name, onClose, onSave }: { name: string; onClose: () => void; onSave: (name: string) => Promise<PanelResult<unknown>> }) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await onSave(value).catch(() => null);
    setBusy(false);
    if (r?.ok) onClose();
    else setError(r?.error ?? "That didn't work on this computer.");
  }
  return (
    <Dialog title="Rename panel" onClose={onClose} width={380}>
      <form onSubmit={(e) => void submit(e)}>
        <Field label="Name" htmlFor="panel-name">
          <TextInput id="panel-name" data-autofocus value={value} maxLength={PANEL_LIMITS.nameChars} onChange={(e) => setValue(e.target.value)} />
        </Field>
        {error && <ErrorLine>{error}</ErrorLine>}
        <div className="dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={value.trim() === "" || value.trim() === name}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function IconDialog({ current, onClose, onPick }: { current: PanelIcon; onClose: () => void; onPick: (icon: PanelIcon) => Promise<PanelResult<unknown>> }) {
  const toast = useToast();
  return (
    <Dialog title="Panel icon" onClose={onClose} width={360}>
      <div className="panel-icons">
        {PANEL_ICONS.map((icon) => {
          const View = PANEL_ICON_VIEWS[icon];
          return (
            <button
              key={icon}
              type="button"
              className={`panel-icon ${icon === current ? "on" : ""}`}
              aria-label={icon}
              aria-pressed={icon === current}
              onClick={() =>
                void onPick(icon).then((r) => {
                  if (r.ok) onClose();
                  else toast.push(r.error, "error");
                })
              }
            >
              <View size={18} strokeWidth={STROKE} aria-hidden />
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}
