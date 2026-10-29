import type { ProjectDesign, ProjectMember, ProjectSummary } from "@mc/shared";
import { MoreHorizontal, Shapes, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api.ts";
import { fetchProjectMembers, useApp } from "../../data.tsx";
import { joinProject, onProjectEvent } from "../../lib/projectChannel.ts";
import { listTime } from "../../lib/time.ts";
import { ConfirmDialog } from "../Dialogs.tsx";
import { ErrorLine, ICON_SM, IconButton, Menu, Spinner, STROKE } from "../kit.tsx";

// The Designs tab beside Files: the project's designs, newest change first. Everyone in the project sees and opens them;
// the person who made one, the host and admins can delete it. The list follows saves and deletes live.

export function DesignsBody({ project }: { project: ProjectSummary }) {
  const { me, design } = useApp();
  const [designs, setDesigns] = useState<ProjectDesign[] | null>(null);
  const [people, setPeople] = useState<Map<string, ProjectMember>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ProjectDesign | null>(null);

  const load = useCallback(() => {
    api.designList(project.id).then(
      (r) => {
        setDesigns(r.designs);
        setError(null);
      },
      (e: unknown) => {
        setDesigns((cur) => cur ?? []);
        setError(e instanceof Error ? e.message : "The designs could not be loaded.");
      },
    );
  }, [project.id]);

  useEffect(() => {
    load();
    fetchProjectMembers(project.id).then(
      (m) => setPeople(new Map(m.map((p) => [p.id, p]))),
      () => undefined,
    );
    const leave = joinProject(project.id, me.id);
    const offs = [onProjectEvent(project.id, "design_list", load), onProjectEvent(project.id, "design_saved", load), onProjectEvent(project.id, "design_ai", (p) => p.state === "done" && load())];
    return () => {
      for (const off of offs) off();
      leave();
    };
  }, [project.id, me.id, load]);

  const canDelete = (d: ProjectDesign) => d.createdBy === me.id || project.my_role === "host" || project.my_role === "admin";

  return (
    <div className="side-card-body notes-body">
      {designs === null ? (
        <div className="notes-empty">
          <Spinner />
        </div>
      ) : designs.length === 0 && !error ? (
        <p className="small muted notes-empty">No designs yet. Make one with +, or ask the AI in a chat to draw a screen.</p>
      ) : (
        designs.map((d) => {
          const by = d.updatedBy ? people.get(d.updatedBy)?.display_name : undefined;
          return (
            <div key={d.path} className={`note-row ${design.path === d.path ? "on" : ""}`}>
              <button type="button" className="note-open" onClick={() => design.open(d.path)}>
                <span className="note-avatar">
                  <Shapes size={ICON_SM} strokeWidth={STROKE} aria-hidden />
                </span>
                <span className="note-text">
                  <span className="note-title truncate">{d.name}</span>
                  {by && <span className="small muted truncate">Changed by {by}</span>}
                </span>
                <span className="note-time small muted">{listTime(d.updatedAt)}</span>
              </button>
              {canDelete(d) && (
                <span className="note-menu">
                  <Menu
                    label="Design options"
                    align="end"
                    items={[{ label: "Delete", danger: true, icon: <Trash2 size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => setDeleting(d) }]}
                    trigger={({ toggle, open }) => (
                      <IconButton label="Design options" className={`sm note-more ${open ? "open" : ""}`} onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
                        <MoreHorizontal size={ICON_SM} strokeWidth={STROKE} />
                      </IconButton>
                    )}
                  />
                </span>
              )}
            </div>
          );
        })
      )}
      <ErrorLine>{error}</ErrorLine>
      {deleting && (
        <ConfirmDialog
          title="Delete this design?"
          confirmLabel="Delete design"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.designDelete(project.id, deleting.path);
            if (design.path === deleting.path) design.close();
            load();
          }}
        >
          <b className="strong">{deleting.name}</b> is removed for everyone in {project.name}.
        </ConfirmDialog>
      )}
    </div>
  );
}
