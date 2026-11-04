import { PANEL_REPLACES_LABEL, type DraftView, type PanelShape } from "@mc/shared";
import { Renderer } from "@openuidev/react-lang";
import { LayoutPanelTop } from "lucide-react";
import { useMemo, useState } from "react";
import { BlockBoundary } from "../genui/GeneratedAnswer.tsx";
import { GenTextContext } from "../genui/library.tsx";
import { panelLibrary, PanelDataContext, type PanelData, type SourceState } from "../genui/panel-library.tsx";
import { copyText } from "../lib/actions.ts";
import { draftInOpenChat } from "../lib/drafts.ts";
import { buttonActions, drawable, newInUpdate, outline } from "../lib/panelCheck.ts";
import { panelsBridge } from "../lib/panels.ts";
import { Button, Dialog, ICON_SM, STROKE, useToast } from "./kit.tsx";
import { Markdown } from "./Markdown.tsx";

// What the AI proposed for the signed-in person's panels, shown in the corner like the other things waiting on this computer.
// The person reviews a wireframe and a list of what the panel reads and does (never code) and clicks Add or Update. The click
// names only the proposal: the app saves the one it kept. Everything on a card is drawn by Nido from the proposal's text.

const markdownText = (text: string) => <Markdown text={text} />;
const noAct: PanelData["act"] = { fix: () => undefined, askToFix: () => undefined };

/** A proposal that stands in for one of Nido's own tabs says so, and that the person can switch back. */
function Replaces({ shape }: { shape: PanelShape }) {
  if (!shape.replaces) return null;
  const name = PANEL_REPLACES_LABEL[shape.replaces];
  return (
    <p className="small panel-replaces">
      <mark>Replaces Nido's {name} tab.</mark> You can switch back to Nido's own {name} tab any time, from this panel's menu.
    </p>
  );
}

/** The wireframe of a proposal: the real pieces, with a placeholder where data would be, and nothing clickable. */
function Wireframe({ shape }: { shape: PanelShape }) {
  const data: PanelData = useMemo(() => ({ sources: Object.fromEntries(shape.sources.map((s) => [s.id, { label: s.label, status: "sample" as const } satisfies SourceState])), act: noAct }), [shape.sources]);
  return (
    <GenTextContext.Provider value={markdownText}>
      <PanelDataContext.Provider value={data}>
        <BlockBoundary fallback={<div className="gen-need">This wireframe couldn't be drawn.</div>}>
          <div className="gen-block gen-preview">
            <Renderer library={panelLibrary} response={shape.view} onError={() => undefined} />
          </div>
        </BlockBoundary>
      </PanelDataContext.Provider>
    </GenTextContext.Provider>
  );
}

/** "Data & functions": what the panel reads, what it does, what it cannot do. Words, no code. */
export function Details({ shape }: { shape: PanelShape }) {
  const servers = [...new Set(shape.sources.map((s) => s.server))];
  // Read from the program itself: a description written by the AI could say anything, the buttons' real targets can't.
  const actions = buttonActions(shape.view);
  return (
    <table className="gen-table panel-details">
      <tbody>
        <tr>
          <th colSpan={2}>Data it shows</th>
        </tr>
        {shape.sources.length === 0 && (
          <tr>
            <td colSpan={2}>Nothing from your connected services.</td>
          </tr>
        )}
        {shape.sources.map((s) => (
          <tr key={s.id}>
            <td>{s.label}</td>
            <td>
              {s.server} (your sign-in). Read: {s.purpose}. Refreshes on open and on refresh.
            </td>
          </tr>
        ))}
        <tr>
          <th colSpan={2}>Functions</th>
        </tr>
        {shape.functions.length === 0 && (
          <tr>
            <td colSpan={2}>None. It only shows things.</td>
          </tr>
        )}
        {shape.functions.map((f) => (
          <tr key={f.id}>
            <td>{f.label}</td>
            <td>{f.description}</td>
          </tr>
        ))}
        {actions.length > 0 && (
          <>
            <tr>
              <th colSpan={2}>What its buttons do (read from the panel)</th>
            </tr>
            {actions.map((a) => (
              <tr key={a}>
                <td colSpan={2}>{a}</td>
              </tr>
            ))}
          </>
        )}
        <tr>
          <th colSpan={2}>Cannot</th>
        </tr>
        <tr>
          <td colSpan={2}>Change anything in {servers.length ? servers.join(", ") : "your services"}, read your files or chats, or use the network by itself.</td>
        </tr>
      </tbody>
    </table>
  );
}

function Review({ draft, onAdd, onClose, busy }: { draft: DraftView; onAdd: () => void; onClose: () => void; busy: boolean }) {
  const [tab, setTab] = useState<"wireframe" | "data">("wireframe");
  const fresh = draft.kind === "update" && draft.before ? newInUpdate(draft.before, draft) : [];
  return (
    <Dialog
      title={`${draft.kind === "update" ? "Update" : "New panel"} · ${draft.name}`}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={onAdd}>
            {draft.kind === "update" ? "Update panel" : "Add panel"}
          </Button>
        </>
      }
    >
      <div className="panel-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "wireframe"} className={tab === "wireframe" ? "on" : ""} onClick={() => setTab("wireframe")}>
          Wireframe
        </button>
        <button type="button" role="tab" aria-selected={tab === "data"} className={tab === "data" ? "on" : ""} onClick={() => setTab("data")}>
          Data &amp; functions
        </button>
      </div>
      {fresh.length > 0 && (
        <ul className="panel-new">
          {fresh.map((t) => (
            <li key={t}>
              <mark>{t}</mark>
            </li>
          ))}
        </ul>
      )}
      <Replaces shape={draft} />
      {tab === "wireframe" ? <Wireframe shape={draft} /> : <Details shape={draft} />}
    </Dialog>
  );
}

function Outlines({ before, now }: { before: PanelShape; now: PanelShape }) {
  const a = outline(before.view, before.sources);
  const b = outline(now.view, now.sources);
  return (
    <div className="panel-diff">
      <ul className="old">
        <li className="muted">before</li>
        {a.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <ul>
        <li className="muted">after</li>
        {b.map((l) => (
          <li key={l} className={a.includes(l) ? "" : "added"}>
            {a.includes(l) ? "" : "+ "}
            {l}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Card({ draft }: { draft: DraftView }) {
  const toast = useToast();
  const bridge = panelsBridge();
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  const ok = useMemo(() => draft.kind === "delete" || drawable(draft.view), [draft.kind, draft.view]);
  const update = draft.kind === "update";

  async function add() {
    if (!bridge) return;
    setBusy(true);
    const r = await bridge.commitDraft(draft.projectId, draft.id).catch(() => null);
    setBusy(false);
    if (r?.ok) {
      setReview(false);
      toast.push(`“${draft.name}” ${r.value.kind === "update" ? "updated" : "added"}`, "info");
    } else toast.push(r?.error ?? "That didn't work on this computer.", "error");
  }
  const notNow = () => void bridge?.discardDraft(draft.projectId, draft.id);
  const askToTrim = () => {
    const text = `Your draft of the "${draft.name}" panel couldn't be drawn (too big, or it uses a part Nido does not have). Please make it simpler and draft it again.`;
    if (!draftInOpenChat(text)) void copyText(text).then((done) => toast.push(done ? "Copied. Open a chat to paste it" : "Could not copy", "info"));
    notNow();
  };

  if (draft.kind === "delete") {
    return (
      <section className="gen-card panel-draft" aria-label={`Delete panel ${draft.name}`}>
        <header>
          <div className="gen-title">Needs you · Delete panel</div>
        </header>
        <p className="small">
          “{draft.name}” on this computer.{" "}
          <Button
            size="sm"
            onClick={() =>
              void bridge?.delete(draft.projectId, draft.panelId!).then((r) => {
                if (r.ok && r.value) toast.push(`“${draft.name}” deleted`, "info");
                else if (!r.ok) toast.push(r.error, "error");
              })
            }
          >
            Delete…
          </Button>{" "}
          <Button size="sm" onClick={notNow}>
            Not now
          </Button>
        </p>
        <p className="small muted">The AI can create and update panels. Deleting is yours.</p>
      </section>
    );
  }

  return (
    <section className="gen-card panel-draft" aria-label={`${update ? "Update" : "New panel"} ${draft.name}`}>
      <header>
        <div className="gen-title">
          <LayoutPanelTop size={ICON_SM} strokeWidth={STROKE} aria-hidden /> {update ? `Update · ${draft.name} v${draft.before!.rev} → v${draft.before!.rev + 1}` : `New panel · ${draft.name}`}
        </div>
      </header>
      {!ok ? (
        <div className="gen-need" role="status">
          <div className="gen-title">Draft refused</div>
          <div className="gen-need-text">Too big, or it uses a part Nido does not have. I will adjust.</div>
          <Button size="sm" onClick={askToTrim}>
            Ask AI to trim
          </Button>
        </div>
      ) : (
        <>
          <Replaces shape={draft} />
          {update ? <Outlines before={draft.before!} now={draft} /> : <Wireframe shape={draft} />}
          {update && newInUpdate(draft.before!, draft).map((t) => <mark key={t}>{t}</mark>)}
          <div className="gen-buttons">
            <Button size="sm" onClick={() => setReview(true)}>
              Review
            </Button>
            <Button size="sm" variant="primary" busy={busy} onClick={() => void add()}>
              {update ? "Update panel" : "Add panel"}
            </Button>
            <Button size="sm" onClick={notNow}>
              Not now
            </Button>
          </div>
        </>
      )}
      {review && <Review draft={draft} busy={busy} onAdd={() => void add()} onClose={() => setReview(false)} />}
    </section>
  );
}

/** The proposals waiting in this project, as cards for the corner dock. */
export function PanelDraftCards({ drafts }: { drafts: DraftView[] }) {
  return (
    <>
      {drafts.map((d) => (
        <Card key={d.id} draft={d} />
      ))}
    </>
  );
}
