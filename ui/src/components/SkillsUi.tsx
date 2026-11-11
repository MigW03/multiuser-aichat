import { cleanLine, normalizeSkillName, parseSkillMd, SKILL_LIMITS, skillProblem, type PluginItem, type PluginPreview, type SkillItem, type SkillsList } from "@mc/shared";
import { ChevronDown, ChevronRight, Eye, FileUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { api } from "../api.ts";
import { findSecret } from "../lib/secrets.ts";
import { notifySkillsChanged, useSkills } from "../lib/skills.ts";
import { ConfirmDialog } from "./Dialogs.tsx";
import { Button, Dialog, ErrorLine, Field, ICON_SM, IconButton, STROKE, TextInput, useToast } from "./kit.tsx";

// Skills: saved instructions the AI follows for a task, and plugins (bundles of skills installed from a file). One list for a
// person's own skills (Settings > Skills) and the same one for a project's (Project settings > Skills). Text only: nothing
// in a skill or a plugin is ever run.

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : "Something went wrong. Try again.");

/** The list, with its buttons and dialogs. `projectId` makes it that project's skills; without it, the signed-in person's own. */
export function SkillsManager({ projectId, projectName }: { projectId?: string; projectName?: string }) {
  const { list, error } = useSkills(projectId);
  const [editing, setEditing] = useState<{ skill: SkillItem | null; readOnly: boolean } | null>(null);
  const [install, setInstall] = useState<{ update?: PluginItem } | null>(null);
  const [deleting, setDeleting] = useState<{ kind: "skill"; skill: SkillItem } | { kind: "plugin"; plugin: PluginItem; count: number } | null>(null);
  const toast = useToast();

  const group = (projectId ? list?.project : list?.mine) ?? null;
  const single = group?.skills.filter((s) => !s.plugin_id) ?? [];
  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      notifySkillsChanged();
    } catch (e) {
      toast.push(messageOf(e), "error");
    }
  };

  return (
    <div className="skills">
      <div className="skills-bar">
        <p className="small muted grow">{projectId ? `Shared. Everyone in ${projectName ?? "the project"} can add, edit and use them.` : "Only you. Used in any chat you ask in."}</p>
        <Button size="sm" variant="primary" onClick={() => setEditing({ skill: null, readOnly: false })}>
          <Plus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> New skill
        </Button>
        <Button size="sm" variant="primary" onClick={() => setInstall({})}>
          <FileUp size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Install plugin
        </Button>
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
      {!list && !error && <p className="small muted">Loading…</p>}
      {group && single.length === 0 && group.plugins.length === 0 && (
        <p className="skills-empty small muted">{projectId ? "No project skills yet. A skill tells the AI how your team likes a task done." : "No skills yet. A skill tells the AI how you like a task done."}</p>
      )}
      {single.length > 0 && (
        <div className="settings-rows skills-rows">
          {single.map((s) => (
            <SkillRow key={s.id} skill={s} showBy={!!projectId} onSet={(body) => run(() => api.setSkill(s.id, body, projectId))} actions={
              <>
                <IconButton label={`Edit ${s.name}`} onClick={() => setEditing({ skill: s, readOnly: false })}>
                  <Pencil size={ICON_SM} strokeWidth={STROKE} />
                </IconButton>
                <IconButton label={`Delete ${s.name}`} onClick={() => setDeleting({ kind: "skill", skill: s })}>
                  <Trash2 size={ICON_SM} strokeWidth={STROKE} />
                </IconButton>
              </>
            } />
          ))}
        </div>
      )}
      {group?.plugins.map((p) => {
        const skills = group.skills.filter((s) => s.plugin_id === p.id);
        return (
          <PluginGroup
            key={p.id}
            plugin={p}
            skills={skills}
            showBy={!!projectId}
            onEnabled={(on) => run(() => api.setPlugin(p.id, on, projectId))}
            onUpdate={() => setInstall({ update: p })}
            onUninstall={() => setDeleting({ kind: "plugin", plugin: p, count: skills.length })}
            onView={(s) => setEditing({ skill: s, readOnly: true })}
            onSet={(s, body) => run(() => api.setSkill(s.id, body, projectId))}
          />
        );
      })}
      {editing && <SkillDialog skill={editing.skill} readOnly={editing.readOnly} {...(projectId ? { projectId } : {})} onClose={() => setEditing(null)} />}
      {install && <InstallPluginDialog {...(projectId ? { projectId } : {})} {...(projectName ? { projectName } : {})} {...(install.update ? { update: install.update } : {})} onClose={() => setInstall(null)} />}
      {deleting?.kind === "skill" && (
        <ConfirmDialog title={`Delete /${deleting.skill.name}?`} confirmLabel="Delete" danger onClose={() => setDeleting(null)} onConfirm={async () => { await api.deleteSkill(deleting.skill.id, projectId); notifySkillsChanged(); }}>
          Chats keep their old answers. This can't be undone.
        </ConfirmDialog>
      )}
      {deleting?.kind === "plugin" && (
        <ConfirmDialog title={`Remove ${deleting.plugin.name}?`} confirmLabel="Remove" danger onClose={() => setDeleting(null)} onConfirm={async () => { await api.deletePlugin(deleting.plugin.id, projectId); notifySkillsChanged(); }}>
          Remove {deleting.plugin.name} and its {deleting.count} {deleting.count === 1 ? "skill" : "skills"}? Old answers stay.
        </ConfirmDialog>
      )}
    </div>
  );
}

function SkillRow({ skill, showBy, onSet, actions, nested }: { skill: SkillItem; showBy: boolean; onSet: (body: { enabled?: boolean; auto_use?: boolean }) => void; actions: React.ReactNode; nested?: boolean }) {
  return (
    <div className={`setting-row skill-row ${nested ? "nested" : ""}`}>
      <div className="grow">
        <div className="strong skill-name">
          /{skill.name} {!skill.enabled && <span className="small muted">· off</span>}
          {showBy && skill.by && !nested && <span className="small muted"> · by {skill.by}</span>}
        </div>
        <p className="small muted">{skill.description}</p>
        <label className="skill-auto small muted">
          <input type="checkbox" checked={skill.auto_use} onChange={(e) => onSet({ auto_use: e.target.checked })} /> The AI may use it on its own
        </label>
      </div>
      <div className="skill-actions">{actions}</div>
      <input type="checkbox" className="setting-switch" role="switch" aria-label={`${skill.name} on`} checked={skill.enabled} onChange={(e) => onSet({ enabled: e.target.checked })} />
    </div>
  );
}

function PluginGroup({ plugin, skills, showBy, onEnabled, onUpdate, onUninstall, onView, onSet }: {
  plugin: PluginItem;
  skills: SkillItem[];
  showBy: boolean;
  onEnabled: (on: boolean) => void;
  onUpdate: () => void;
  onUninstall: () => void;
  onView: (s: SkillItem) => void;
  onSet: (s: SkillItem, body: { enabled?: boolean; auto_use?: boolean }) => void;
}) {
  const [open, setOpen] = useState(false);
  const Chev = open ? ChevronDown : ChevronRight;
  return (
    <div className="settings-rows skills-rows skill-plugin">
      <div className="setting-row">
        <button type="button" className="skill-fold" aria-expanded={open} aria-label={`${open ? "Fold" : "Unfold"} ${plugin.name}`} onClick={() => setOpen(!open)}>
          <Chev size={ICON_SM} strokeWidth={STROKE} aria-hidden />
        </button>
        <div className="grow">
          <div className="strong">
            {plugin.name} <span className="small muted">{[plugin.version && `v${plugin.version}`, plugin.author && `by ${plugin.author}`, `${skills.length} ${skills.length === 1 ? "skill" : "skills"}`].filter(Boolean).join(" · ")}</span>
          </div>
          {plugin.description && <p className="small muted">{plugin.description}</p>}
          {showBy && plugin.by && <p className="small muted">Installed by {plugin.by}</p>}
          <div className="skill-actions plugin-actions">
            <Button size="sm" variant="ghost" onClick={onUpdate}>Update</Button>
            <Button size="sm" variant="ghost" onClick={onUninstall}>Uninstall</Button>
          </div>
        </div>
        <input type="checkbox" className="setting-switch" role="switch" aria-label={`${plugin.name} on`} checked={plugin.enabled} onChange={(e) => onEnabled(e.target.checked)} />
      </div>
      {open &&
        skills.map((s) => (
          <SkillRow key={s.id} skill={s} nested showBy={false} onSet={(body) => onSet(s, body)} actions={
            <IconButton label={`View ${s.name}`} onClick={() => onView(s)}>
              <Eye size={ICON_SM} strokeWidth={STROKE} />
            </IconButton>
          } />
        ))}
    </div>
  );
}

// ------------------------------------------------------------------ one skill

/** New skill (no `skill`), edit, or a read-only view (a plugin's skill). */
function SkillDialog({ skill, readOnly, projectId, onClose }: { skill: SkillItem | null; readOnly: boolean; projectId?: string; onClose: () => void }) {
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [body, setBody] = useState("");
  const [auto, setAuto] = useState(skill?.auto_use ?? true);
  const [loaded, setLoaded] = useState(!skill);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => {
    if (!skill) return;
    let live = true;
    api
      .skill(skill.id, projectId)
      .then((s) => live && (setBody(s.body), setLoaded(true)))
      .catch((e) => live && setError(messageOf(e)));
    return () => {
      live = false;
    };
  }, [skill, projectId]);

  const problem = skillProblem({ name, description, body });

  async function importFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 256 * 1024) return setError("That file is too large to be a skill.");
    const parsed = parseSkillMd(await f.text());
    setName(normalizeSkillName(parsed.name || f.name.replace(/\.[^.]+$/, "")));
    setDescription(cleanLine(parsed.description, 10_000));
    setBody(parsed.body);
    setError(null);
    setNotice(`Read ${f.name}. Check it, then save. Only the text is imported.`);
  }

  async function save() {
    if (problem) return setError(problem);
    // The text goes to the AI's provider whenever the skill is used, and a project's skills are read by everyone in it.
    const secret = findSecret(`${description}\n${body}`);
    if (secret) return setError(`This looks like a ${secret.kind}. Take it out: the text goes to the AI whenever the skill is used.`);
    setBusy(true);
    setError(null);
    try {
      const input = { name, description: cleanLine(description, 1000), body, auto_use: auto };
      if (skill) await api.saveSkill(skill.id, input, projectId);
      else await api.addSkill(input, projectId);
      notifySkillsChanged();
      toast.push(skill ? "Skill saved." : "Skill added.");
      onClose();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  }

  return (
    <Dialog title={readOnly ? `/${skill?.name}` : skill ? "Edit skill" : "New skill"} onClose={onClose} width={560}>
      {readOnly && <p className="small muted">This skill comes with a plugin, so it can't be edited here. Update the plugin to change it.</p>}
      <Field label="Name" hint="Used as /name. Lowercase letters, digits and dashes." htmlFor="skill-name">
        <TextInput id="skill-name" value={name} maxLength={SKILL_LIMITS.nameChars} readOnly={readOnly} onChange={(e) => setName(e.target.value)} placeholder="release-notes" autoFocus={!readOnly} spellCheck={false} />
      </Field>
      <Field label="When to use it" hint="The AI reads this line to decide whether the skill fits." htmlFor="skill-desc">
        <TextInput id="skill-desc" value={description} maxLength={SKILL_LIMITS.descriptionChars} readOnly={readOnly} onChange={(e) => setDescription(e.target.value)} placeholder="Use when asked to write release notes for users." />
      </Field>
      <Field label="Instructions" hint={`Markdown. ${body.length.toLocaleString("en-US")} / ${SKILL_LIMITS.bodyChars.toLocaleString("en-US")} characters. Don't put passwords or keys here: the text goes to the AI whenever the skill is used.`} htmlFor="skill-body">
        <textarea id="skill-body" className="input skill-body" rows={10} value={loaded ? body : "Loading…"} readOnly={readOnly || !loaded} onChange={(e) => setBody(e.target.value)} spellCheck={false} placeholder={"# Release notes\n1. Group by: New, Improved, Fixed.\n2. One line each, plain words."} />
      </Field>
      {!readOnly && (
        <label className="skill-auto-row">
          <input type="checkbox" className="setting-switch" role="switch" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>
            <span className="strong">The AI may use it on its own</span>
            <span className="small muted block">Off: it runs only when someone types /{name || "name"}.</span>
          </span>
        </label>
      )}
      {notice && <p className="small muted">{notice}</p>}
      {error && <ErrorLine>{error}</ErrorLine>}
      <div className="dialog-actions">
        {!readOnly && (
          <>
            <input ref={file} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ""; }} />
            <Button variant="ghost" onClick={() => file.current?.click()}>
              <FileUp size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Import SKILL.md…
            </Button>
            <span className="grow" />
          </>
        )}
        <Button onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
        {!readOnly && (
          <Button variant="primary" busy={busy} disabled={!loaded || !!problem} onClick={() => void save()} title={problem ?? undefined}>
            Save
          </Button>
        )}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ install a plugin

function InstallPluginDialog({ projectId, projectName, update, onClose }: { projectId?: string; projectName?: string; update?: PluginItem; onClose: () => void }) {
  // In a project's settings the person can install for the project or for themselves; from Settings it is always for them.
  const [forProject, setForProject] = useState(!!projectId);
  const target = forProject ? projectId : undefined;
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();

  // Looks inside the file (again when the place changes: an update is told by the place). Nothing is saved yet.
  useEffect(() => {
    if (!file) return;
    let live = true;
    setReading(true);
    setError(null);
    api
      .previewPlugin(file, target)
      .then((p) => {
        if (!live) return;
        setPreview(p);
        setPicked((cur) => (cur.size ? new Set([...cur].filter((n) => p.skills.some((s) => s.name === n && !s.problem))) : new Set(p.skills.filter((s) => !s.problem).map((s) => s.name))));
      })
      .catch((e) => live && (setPreview(null), setError(messageOf(e))))
      .finally(() => live && setReading(false));
    return () => {
      live = false;
    };
  }, [file, target]);

  function choose(f: File | undefined | null) {
    if (!f) return;
    setPreview(null);
    setPicked(new Set());
    if (f.size > SKILL_LIMITS.zipBytes) return setError("That file is over 1 MB.");
    setFile(f);
  }
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    choose(e.dataTransfer.files[0]);
  };

  const wrongPlugin = !!update && !!preview && preview.name !== update.name;
  async function submit() {
    if (!file || !preview || picked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.installPlugin(file, [...picked], target);
      notifySkillsChanged();
      toast.push(preview.update ? `${preview.name} updated.` : `${preview.name} installed. Turn on "The AI may use it on its own" for the skills you want.`);
      onClose();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  }

  const out = preview?.left_out;
  const leftOut = out ? [out.commands && `${out.commands} ${out.commands === 1 ? "command" : "commands"}`, out.mcp && `${out.mcp} MCP ${out.mcp === 1 ? "server" : "servers"}`, out.hooks && `${out.hooks} ${out.hooks === 1 ? "hook" : "hooks"}`, out.scripts && `${out.scripts} script ${out.scripts === 1 ? "file" : "files"}`, out.other && `${out.other} other ${out.other === 1 ? "file" : "files"}`].filter(Boolean) : [];

  return (
    <Dialog title={update ? `Update ${update.name}` : "Install plugin"} onClose={onClose} width={560}>
      <p className="small muted">A plugin is a .zip file with several skills in it. Nido installs only the skills: nothing in a plugin is ever run. Only install plugins you trust.</p>
      <div
        className={`skill-drop ${over ? "over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <input ref={input} type="file" accept=".zip,.plugin,application/zip" hidden onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
        {file ? <span className="strong">{file.name}</span> : <span>Drop a .zip or .plugin file here, or</span>}{" "}
        <button type="button" className="link-btn" onClick={() => input.current?.click()}>{file ? "choose another" : "choose file"}</button>
      </div>
      {reading && <p className="small muted">Looking inside…</p>}
      {error && <ErrorLine>{error}</ErrorLine>}
      {preview && (
        <>
          <div className="skill-preview">
            <div className="strong">
              {preview.name} <span className="small muted">{[preview.version && `v${preview.version}`, preview.author && `by ${preview.author}`].filter(Boolean).join(" · ")}</span>
            </div>
            {preview.description && <p className="small muted">{preview.description}</p>}
            {preview.update && (
              <p className="small">
                Already installed (v{preview.update.from || "?"}). Update: {preview.update.added} new, {preview.update.changed} changed, {preview.update.removed} removed. Skills you switched off stay off.
              </p>
            )}
            <ul className="skill-pick">
              {preview.skills.map((s) => (
                <li key={s.name}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={!!s.problem}
                      checked={picked.has(s.name)}
                      onChange={(e) => setPicked((cur) => { const n = new Set(cur); if (e.target.checked) n.add(s.name); else n.delete(s.name); return n; })}
                    />{" "}
                    <span className="strong">{s.name}</span> <span className="small muted">{s.problem ?? s.description}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
          {leftOut.length > 0 && (
            <div className="skill-leftout small">
              <b>Left out, Nido can't run these:</b> {leftOut.join(", ")}. Only skill text is installed.
            </div>
          )}
          {projectId && !update && (
            <div className="skill-target">
              <span className="small muted">Install for</span>
              <div className="segmented" role="radiogroup" aria-label="Install for">
                <button type="button" role="radio" aria-checked={!forProject} className={`seg ${forProject ? "" : "on"}`} onClick={() => setForProject(false)}>Just me</button>
                <button type="button" role="radio" aria-checked={forProject} className={`seg ${forProject ? "on" : ""}`} onClick={() => setForProject(true)}>{projectName ? `Project: ${projectName}` : "This project"}</button>
              </div>
            </div>
          )}
          {wrongPlugin && <ErrorLine>This file is {preview.name}, not {update?.name}. Choose the {update?.name} file to update it.</ErrorLine>}
        </>
      )}
      <div className="dialog-actions">
        <span className="small muted grow">{preview ? `${picked.size} of ${preview.skills.length} skills picked` : ""}</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!preview || picked.size === 0 || wrongPlugin} onClick={() => void submit()}>
          {preview?.update ? "Update plugin" : `Install ${picked.size || ""} ${picked.size === 1 ? "skill" : "skills"}`.replace("  ", " ")}
        </Button>
      </div>
    </Dialog>
  );
}

export type { SkillsList };
