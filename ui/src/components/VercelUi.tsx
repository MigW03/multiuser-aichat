import {
  VERCEL_ERROR_WINDOWS,
  VERCEL_LOG_WINDOWS,
  VERCEL_MCP_URL,
  type ProjectSummary,
  type VercelDeployment,
  type VercelLink,
  type VercelProjectOption,
  type VercelSection,
  type VercelSectionData,
} from "@mc/shared";
import { ArrowLeft, ChevronRight, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, ApiRequestError } from "../api.ts";
import { useApp } from "../data.tsx";
import { draftInOpenChat } from "../lib/drafts.ts";
import { ago, stateDot, vercelTabDot } from "../lib/vercelFormat.ts";
import { notifyVercelChanged, type VercelHook } from "../lib/vercelState.ts";
import { Accordion, Note } from "./SupabaseUi.tsx";
import { Button, Dialog, ErrorLine, ICON_SM, IconButton, Spinner, STROKE, useToast } from "./kit.tsx";

// The Vercel tab of the Files card, and the dialog that links a Nido project to a Vercel project (opened from Project
// settings). The tab only reads: every state, name and log line comes from Vercel through the asking person's own
// connection, as plain text. Environment variables show their NAMES only, never a value. Nothing here changes Vercel; the
// buttons that ask the AI only draft a question in the chat box.

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : "Something went wrong. Try again.");
const openExternal = (url: string | null | undefined) => {
  if (url && /^https:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer"); // the desktop app hands https pages to the system browser
};
export const vercelDashboardUrl = (l: Pick<VercelLink, "teamSlug" | "name">) => (l.teamSlug ? `https://vercel.com/${encodeURIComponent(l.teamSlug)}/${encodeURIComponent(l.name)}` : "https://vercel.com/dashboard");
export const linkText = (l: VercelLink) => (l.teamSlug ? `${l.name} (${l.teamSlug})` : l.name);

// ------------------------------------------------------------------------------------------------ connecting

/** Adds the Vercel entry to this person's MCP servers (when there is none) and starts its sign-in in the browser. */
export function useConnectVercel(vh: VercelHook) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async (id: string) => {
    const { url } = await api.mcpSignIn(id);
    openExternal(url);
    vh.watch();
    await vh.reload();
    notifyVercelChanged();
  };

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    error,
    /** No entry yet: add it, then sign in. An entry that needs a sign-in: sign in. */
    connect: () =>
      run(async () => {
        let id = vh.state?.mine.serverId;
        if (!id) {
          for (const name of ["vercel", "vercel-2", "vercel-3"]) {
            try {
              id = (await api.mcpAdd({ name, url: VERCEL_MCP_URL, auth: { kind: "oauth" } })).id;
              break;
            } catch (e) {
              if (e instanceof ApiRequestError && /already have a server/i.test(e.message)) continue; // that name is taken by another entry
              throw e;
            }
          }
          if (!id) throw new Error("Could not add Vercel. Try again.");
        }
        await signIn(id);
      }),
    retry: () =>
      run(async () => {
        const id = vh.state?.mine.serverId;
        if (!id) return;
        await api.mcpRetry(id);
        vh.watch();
        await vh.reload();
      }),
    turnOn: () =>
      run(async () => {
        const id = vh.state?.mine.serverId;
        if (!id) return;
        await api.mcpSet(id, { enabled: true });
        vh.watch();
        await vh.reload();
        notifyVercelChanged();
      }),
  };
}

type DialogMode = "link" | "change" | "setup";

/** Link a Vercel project to this Nido project: 1 Connect (only if Vercel is not set up yet), 2 Choose. "setup" is only step 1, for someone who just wants to see a project that is already linked. */
export function LinkVercelDialog({ project, vh, mode, onClose }: { project: ProjectSummary; vh: VercelHook; mode: DialogMode; onClose: () => void }) {
  const toast = useToast();
  const state = vh.state;
  const mine = state?.mine.state ?? "none";
  const ready = mine === "ready";
  const connect = useConnectVercel(vh);
  const [asked, setAsked] = useState(false); // the person pressed Connect or Sign in: now we wait for them to finish in the browser
  const [projects, setProjects] = useState<VercelProjectOption[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [team, setTeam] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const step = !ready ? 1 : mode === "setup" ? 3 : 2;
  const current = state?.link?.projectId ?? null;

  useEffect(() => {
    if (step !== 3) return;
    toast.push("Vercel is set up. The tab is in the Files card.");
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => {
    if (step !== 2) return;
    let live = true;
    setProjects(null);
    setListError(null);
    api.vercelProjects(project.id).then(
      (r) => {
        if (!live) return;
        setProjects(r.projects);
        setTeam((t) => t ?? r.projects[0]?.teamId ?? null);
        setPick((p) => p ?? r.projects.find((x) => x.projectId !== current)?.projectId ?? null);
      },
      (e) => live && setListError(messageOf(e)),
    );
    return () => {
      live = false;
    };
  }, [step, project.id, reload, current]);

  const teams = projects ? [...new Map(projects.map((p) => [p.teamId, p.teamName])).entries()] : [];
  const shown = projects?.filter((p) => p.teamId === team) ?? [];
  const picked = projects?.find((p) => p.projectId === pick && p.teamId === team) ?? null;

  const link = async () => {
    if (!picked) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.vercelLink(project.id, { teamId: picked.teamId, projectId: picked.projectId });
      notifyVercelChanged();
      toast.push(mode === "change" ? "Vercel project changed." : "Vercel tab added to Files.");
      onClose();
    } catch (e) {
      setSaveError(messageOf(e));
      setSaving(false);
    }
  };

  const labels = mode === "setup" ? ["1 Connect"] : ["1 Connect", "2 Choose"];
  const title = mode === "change" ? "Change Vercel project" : mode === "setup" ? "Set up Vercel" : "Link a Vercel project";

  let body: ReactNode;
  let footer: ReactNode = <Button onClick={onClose}>Cancel</Button>;
  if (!state) {
    body = <Spinner />;
  } else if (step === 1) {
    const waiting = asked && (mine === "needs_sign_in" || mine === "connecting");
    body = (
      <>
        {mine === "none" && <p>Vercel is not connected on your account yet. Connecting adds it to your MCP servers.</p>}
        {mine === "needs_sign_in" && !waiting && <p>Sign in to Vercel to go on.</p>}
        {mine === "failed" && <p>Could not connect to Vercel{state.mine.error ? `: ${state.mine.error}` : "."}</p>}
        {mine === "off" && <p>Vercel is turned off in your MCP servers.</p>}
        {mine === "connecting" && !waiting && (
          <p>
            <Spinner /> Connecting to Vercel…
          </p>
        )}
        {waiting && (
          <p className="supa-wait">
            <span className="mdot connecting" aria-hidden /> Waiting for the Vercel sign-in… Finish it in the browser window. This moves on by itself.
          </p>
        )}
        {!state.oauthAvailable && (mine === "none" || mine === "needs_sign_in") && <p className="small muted">Signing in to Vercel is not set up on this chat server.</p>}
        {mine === "none" && <p className="small muted">Opens the Vercel sign-in in your browser. Your own Vercel account: pick the team that owns the project. The AI gets only the tools for looking, not for changing.</p>}
        <ErrorLine>{connect.error}</ErrorLine>
      </>
    );
    const go = async (f: () => Promise<void>) => {
      setAsked(true);
      await f();
    };
    footer = (
      <>
        <Button onClick={onClose}>Cancel</Button>
        {mine === "none" && (
          <Button variant="primary" busy={connect.busy} disabled={!state.oauthAvailable} onClick={() => void go(connect.connect)}>
            Connect Vercel
          </Button>
        )}
        {mine === "needs_sign_in" && (
          <Button variant="primary" busy={connect.busy} disabled={!state.oauthAvailable} onClick={() => void go(connect.connect)}>
            {waiting ? "Open sign-in again" : "Sign in to Vercel"}
          </Button>
        )}
        {mine === "failed" && (
          <Button variant="primary" busy={connect.busy} onClick={() => void connect.retry()}>
            Try again
          </Button>
        )}
        {mine === "off" && (
          <Button variant="primary" busy={connect.busy} onClick={() => void connect.turnOn()}>
            Turn it on
          </Button>
        )}
      </>
    );
  } else {
    body = (
      <>
        {listError ? (
          <ErrorLine>{listError}</ErrorLine>
        ) : projects === null ? (
          <Spinner />
        ) : projects.length === 0 ? (
          <>
            <p>No Vercel projects in this account.</p>
            <p className="small muted">Create one in Vercel, then come back.</p>
          </>
        ) : (
          <>
            {teams.length > 1 && (
              <label className="small muted vcl-team">
                Team{" "}
                <select
                  className="input"
                  aria-label="Vercel team"
                  value={team ?? ""}
                  onChange={(e) => {
                    setTeam(e.target.value);
                    setPick(null);
                  }}
                >
                  {teams.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <fieldset className="supa-pick">
              <legend className="small muted">{teams.length === 1 ? `Projects of ${teams[0]![1]}` : "Your Vercel projects"}</legend>
              {shown.map((p) => (
                <label key={p.projectId} className={`supa-pick-row ${pick === p.projectId ? "on" : ""}`}>
                  <input type="radio" name="vercel-project" checked={pick === p.projectId} disabled={p.projectId === current} onChange={() => setPick(p.projectId)} />
                  <span className="supa-pick-text">
                    <span className="strong">{p.name}</span>
                    <span className="small muted">{p.projectId === current ? "linked now" : p.teamName}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <p className="small muted">Everyone in {project.name} will see the project's name and team. What they see inside comes from their own Vercel account.</p>
          </>
        )}
        <ErrorLine>{saveError}</ErrorLine>
      </>
    );
    footer = (
      <>
        <Button onClick={onClose}>Cancel</Button>
        {listError || (projects && projects.length === 0) ? (
          <>
            <Button onClick={() => openExternal("https://vercel.com/dashboard")}>Open Vercel</Button>
            <Button variant="primary" onClick={() => setReload((n) => n + 1)}>
              Refresh list
            </Button>
          </>
        ) : (
          <Button variant="primary" busy={saving} disabled={!picked} onClick={() => void link()}>
            {mode === "change" ? "Change project" : "Link project"}
          </Button>
        )}
      </>
    );
  }

  return (
    <Dialog title={title} onClose={onClose} width={460} footer={footer}>
      <p className="small muted supa-steps">
        {labels.map((l, i) => (
          <span key={l} className={i + 1 === Math.min(step, labels.length) ? "strong" : ""}>
            {i > 0 && " · "}
            {l}
          </span>
        ))}
      </p>
      {body}
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ the tab

type Loaded<S extends VercelSection> = { data: VercelSectionData[S] | null; error: { message: string; code?: string } | null; loading: boolean; reload: () => void };

/** One section of the linked project, read when `enabled` and again when `version` changes. */
function useVercelSection<S extends VercelSection>(projectId: string, section: S, q: { since?: string; minutes?: number; errors?: boolean; deployment?: string }, enabled: boolean, version: number): Loaded<S> {
  const [data, setData] = useState<VercelSectionData[S] | null>(null);
  const [error, setError] = useState<Loaded<S>["error"]>(null);
  const [loading, setLoading] = useState(false);
  const [again, setAgain] = useState(0);
  const key = JSON.stringify(q);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true);
    setError(null);
    api
      .vercelData(projectId, section, JSON.parse(key) as typeof q)
      .then(
        (r) => live && setData(r.data),
        (e) => live && setError({ message: messageOf(e), ...(e instanceof ApiRequestError && e.code ? { code: e.code } : {}) }),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, section, enabled, version, again, key]);
  return { data, error, loading, reload: () => setAgain((n) => n + 1) };
}

/** The first read of the project: what the tab header, the tab dot and the summary come from. One read per open card. */
export function useVercelOverview(projectId: string, enabled: boolean, version: number) {
  return useVercelSection(projectId, "overview", {}, enabled, version);
}
export type VercelOverviewHook = ReturnType<typeof useVercelOverview>;

function SectionState({ s, empty }: { s: Loaded<VercelSection>; empty?: string }) {
  if (s.loading && !s.data) return <Spinner />;
  if (s.error) return <ErrorLine>{s.error.message}</ErrorLine>;
  return empty ? <Note>{empty}</Note> : null;
}

/** A question for the AI, drafted in the chat box. Only fixed words and ids: nothing Vercel wrote is put in it. */
function useAskAi() {
  const toast = useToast();
  return (text: string) => {
    if (draftInOpenChat(text)) return;
    void navigator.clipboard.writeText(text).then(
      () => toast.push("No chat is open. The question is copied: paste it in a chat."),
      () => toast.push("No chat is open. Open one and ask there.", "error"),
    );
  };
}

function DeploymentRow({ d, onOpen }: { d: VercelDeployment; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="supa-table-row vcl-dep" onClick={onOpen} aria-label={`Deployment ${d.sha || d.id}`}>
        <span className={`mdot ${stateDot(d.state)}`} role="img" aria-label={d.state.toLowerCase()} />
        <span className="vcl-dep-text">
          <span className="truncate">
            <b>{d.target === "production" ? "prod" : "preview"}</b> {d.branch}
            {d.sha ? ` · ${d.sha}` : ""}
          </span>
          <span className="small muted truncate">{[d.message, ago(d.createdAt)].filter(Boolean).join(" · ")}</span>
        </span>
        <ChevronRight size={ICON_SM} strokeWidth={STROKE} aria-hidden />
      </button>
    </li>
  );
}

/** One deployment: its facts and, on request, the end of its build log. */
function DeploymentDetail({ project, d, onBack }: { project: ProjectSummary; d: VercelDeployment; onBack: () => void }) {
  const ask = useAskAi();
  const [errors, setErrors] = useState(false);
  const [asked, setAsked] = useState(0);
  // The log is read when asked, never on a timer.
  const s = useVercelSection(project.id, "buildlog", { deployment: d.id, errors }, asked > 0, asked);
  return (
    <div className="side-card-body supa-body">
      <div className="supa-head">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Deployments
        </Button>
        <span className="grow" />
        <span className={`mdot ${stateDot(d.state)}`} role="img" aria-label={d.state.toLowerCase()} />
        <b>{d.state.toLowerCase()}</b>
      </div>
      <p className="small muted supa-summary">
        {[d.target === "production" ? "Production" : "Preview", d.branch, d.sha, ago(d.createdAt), d.author ? `by ${d.author}` : ""].filter(Boolean).join(" · ")}
      </p>
      {d.message && <p className="small vcl-msg">{d.message}</p>}
      <div className="supa-controls">
        <Button size="sm" variant="primary" busy={s.loading} onClick={() => setAsked((n) => n + 1)}>
          Load build log
        </Button>
        <label className="small supa-check">
          <input type="checkbox" checked={errors} onChange={(e) => setErrors(e.target.checked)} /> Errors only
        </label>
        {d.inspectorUrl && (
          <Button size="sm" variant="ghost" onClick={() => openExternal(d.inspectorUrl)}>
            Open in Vercel <ExternalLink size={ICON_SM} strokeWidth={STROKE} aria-hidden />
          </Button>
        )}
      </div>
      {asked === 0 ? (
        <Note>The build log is read when you press Load.</Note>
      ) : s.loading && !s.data ? (
        <Spinner />
      ) : s.error ? (
        <ErrorLine>{s.error.message}</ErrorLine>
      ) : s.data && s.data.lines.length === 0 ? (
        <Note>No lines to show.</Note>
      ) : (
        <ul className="supa-logs vcl-build" aria-label="Build log">
          {s.data?.lines.map((l, i) => (
            <li key={i} className={l.level === "error" ? "vcl-err" : ""}>
              <span className="supa-log-text vcl-wrap">{l.text}</span>
            </li>
          ))}
        </ul>
      )}
      {d.state === "ERROR" && (
        <div>
          <Button size="sm" onClick={() => ask(`Explain why Vercel deployment ${d.id} of ${project.name} failed, and suggest a fix.`)}>
            Ask AI to explain
          </Button>
          <p className="small muted supa-note">Drafts a question in the chat box. Nothing is sent until you press Send.</p>
        </div>
      )}
    </div>
  );
}

const WINDOW_LABEL: Record<number, string> = { 30: "30 min", 60: "1 hour", 360: "6 hours", 1440: "24 hours" };

function ErrorsView({ project, version }: { project: ProjectSummary; version: number }) {
  const ask = useAskAi();
  const [since, setSince] = useState<(typeof VERCEL_ERROR_WINDOWS)[number]>("24h");
  const errors = useVercelSection(project.id, "errors", { since }, true, version);
  const [minutes, setMinutes] = useState<number>(30);
  const [onlyErrors, setOnlyErrors] = useState(true);
  const [applied, setApplied] = useState<{ minutes: number; errors: boolean } | null>(null);
  const logs = useVercelSection(project.id, "logs", applied ?? {}, applied !== null, version);
  const load = () => {
    setApplied({ minutes, errors: onlyErrors });
    if (applied && applied.minutes === minutes && applied.errors === onlyErrors) logs.reload();
  };
  return (
    <>
      <div className="supa-controls">
        <select className="input" aria-label="Error window" value={since} onChange={(e) => setSince(e.target.value as typeof since)}>
          {VERCEL_ERROR_WINDOWS.map((w) => (
            <option key={w} value={w}>
              Last {w === "24h" ? "24 hours" : "7 days"}
            </option>
          ))}
        </select>
      </div>
      {errors.data ? (
        errors.data.none ? (
          <Note>No runtime errors in that window.</Note>
        ) : (
          <>
            <ul className="supa-logs vcl-build" aria-label="Runtime errors">
              {errors.data.lines.map((l, i) => (
                <li key={i} className="vcl-err">
                  <span className="supa-log-text vcl-wrap">{l}</span>
                </li>
              ))}
            </ul>
            <div>
              <Button size="sm" onClick={() => ask(`Look at the runtime errors of ${project.name} on Vercel (last ${since === "24h" ? "24 hours" : "7 days"}) and explain what is wrong.`)}>
                Ask AI
              </Button>
            </div>
          </>
        )
      ) : (
        <SectionState s={errors} />
      )}
      <p className="small muted supa-note">Runtime logs</p>
      <div className="supa-controls">
        <select className="input" aria-label="Log window" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {VERCEL_LOG_WINDOWS.map((m) => (
            <option key={m} value={m}>
              {WINDOW_LABEL[m]}
            </option>
          ))}
        </select>
        <label className="small supa-check">
          <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> Errors only
        </label>
        <Button size="sm" variant="primary" busy={logs.loading} onClick={load}>
          Load
        </Button>
      </div>
      {applied === null ? (
        <Note>Logs are read when you press Load. The free plan keeps one hour.</Note>
      ) : logs.loading && !logs.data ? (
        <Spinner />
      ) : logs.error ? (
        <ErrorLine>{logs.error.message}</ErrorLine>
      ) : logs.data && logs.data.lines.length === 0 ? (
        <Note>No log lines in that window.</Note>
      ) : (
        <ul className="supa-logs vcl-build" aria-label="Runtime logs">
          {logs.data?.lines.map((l, i) => (
            <li key={i}>
              <span className="supa-log-text vcl-wrap">{l}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function VercelBody({ project, vh, overview, onRefresh }: { project: ProjectSummary; vh: VercelHook; overview: VercelOverviewHook; onRefresh: () => void }) {
  const state = vh.state;
  const connect = useConnectVercel(vh);
  const { openSettings } = useApp();
  if (!state?.link) return <div className="side-card-body"><p className="small muted">Not linked.</p></div>;
  const { mine, link } = state;
  const msg = (text: string, action?: ReactNode) => (
    <div className="side-card-body supa-body">
      <p className="small">{text}</p>
      <ErrorLine>{connect.error}</ErrorLine>
      {action}
    </div>
  );
  if (mine.state === "needs_sign_in")
    return msg(
      "Sign in to Vercel to see this project.",
      <div>
        <Button size="sm" variant="primary" busy={connect.busy} disabled={!state.oauthAvailable} onClick={() => void connect.connect()}>
          Sign in to Vercel
        </Button>
      </div>,
    );
  if (mine.state === "failed")
    return msg(
      `Could not connect to Vercel${mine.error ? `: ${mine.error}` : "."}`,
      <div>
        <Button size="sm" variant="primary" busy={connect.busy} onClick={() => void connect.retry()}>
          Try again
        </Button>
      </div>,
    );
  if (mine.state === "off")
    return msg(
      "Vercel is turned off in your MCP servers.",
      <div>
        <Button size="sm" variant="primary" busy={connect.busy} onClick={() => void connect.turnOn()}>
          Turn it on
        </Button>{" "}
        <Button size="sm" variant="ghost" onClick={() => openSettings("mcp", mine.serverId)}>
          MCP servers
        </Button>
      </div>,
    );
  if (mine.state === "connecting")
    return (
      <div className="side-card-body supa-body">
        <p className="small muted">
          <Spinner /> Connecting to Vercel…
        </p>
      </div>
    );
  return <ReadyBody project={project} link={link} overview={overview} onRefresh={onRefresh} />;
}

function ReadyBody({ project, link, overview, onRefresh }: { project: ProjectSummary; link: VercelLink; overview: VercelOverviewHook; onRefresh: () => void }) {
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [deployment, setDeployment] = useState<VercelDeployment | null>(null);
  const deployments = useVercelSection(project.id, "deployments", {}, true, version);
  const domains = useVercelSection(project.id, "domains", {}, open === "domains", version);
  const env = useVercelSection(project.id, "env", {}, open === "env", version);
  const toggle = (id: string) => setOpen((cur) => (cur === id ? null : id));
  const refresh = () => {
    setVersion((n) => n + 1);
    onRefresh();
  };
  const o = overview.data;

  if (deployment) return <DeploymentDetail project={project} d={deployment} onBack={() => setDeployment(null)} />;

  // The first read decides what the person sees: no access to the project, or the Vercel connection needs them.
  if (overview.error && !o) {
    const code = overview.error.code;
    return (
      <div className="side-card-body supa-body">
        <p className="small">{code === "no_access" ? `Your Vercel account has no access to “${link.name}”. Sign in with the team that owns it.` : overview.error.message}</p>
        <div className="supa-actions">
          <Button size="sm" onClick={refresh}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => openExternal(vercelDashboardUrl(link))}>
            Open in Vercel <ExternalLink size={ICON_SM} strokeWidth={STROKE} aria-hidden />
          </Button>
        </div>
      </div>
    );
  }

  const prod = o?.production ?? null;
  const facts = o ? [o.framework, o.node ? `Node ${o.node}` : "", o.repo].filter(Boolean).join(" · ") : "";
  const failedCount = deployments.data ? deployments.data.deployments.filter((d) => d.state === "ERROR").length : null;

  return (
    <div className="side-card-body supa-body">
      <div className="supa-head">
        <span className={`mdot ${prod ? stateDot(prod.state) : o ? "off" : "connecting"}`} role="img" aria-label={prod ? `production ${prod.state.toLowerCase()}` : "Loading"} />
        <b className="truncate" title={link.name}>
          {link.name}
        </b>
        <span className="supa-pill" title="This tab only reads. Make changes in Vercel.">
          read-only
        </span>
        <IconButton label="Refresh" className="sm" onClick={refresh}>
          <RefreshCw size={ICON_SM} strokeWidth={STROKE} aria-hidden />
        </IconButton>
      </div>
      {o ? (
        <>
          <p className="small muted supa-summary">
            {prod ? `Production · ${prod.state.toLowerCase()}${prod.sha ? ` · ${prod.sha}` : ""}${prod.createdAt ? ` · ${ago(prod.createdAt)}` : ""}` : "No production deployment yet"}
            {o.domain ? ` · ${o.domain}` : ""}
          </p>
          {facts && <p className="small muted supa-summary">{facts}</p>}
        </>
      ) : overview.loading ? (
        <Spinner />
      ) : null}
      {prod?.state === "ERROR" && (
        <p className="small supa-paused">
          The latest production build failed. The site keeps serving the last good build.{" "}
          <button type="button" className="link-button" onClick={() => setDeployment(prod)}>
            Open it
          </button>
        </p>
      )}
      <ul className="supa-secs">
        <Accordion title="Deployments" hint={deployments.data ? (failedCount ? `${failedCount} failed` : deployments.data.deployments.length) : undefined} open={open === "deployments"} onToggle={() => toggle("deployments")}>
          {deployments.data ? (
            deployments.data.deployments.length === 0 ? (
              <Note>No deployments yet. Push to the connected Git repository.</Note>
            ) : (
              <ul className="supa-list compact">
                {deployments.data.deployments.map((d) => (
                  <DeploymentRow key={d.id} d={d} onOpen={() => setDeployment(d)} />
                ))}
              </ul>
            )
          ) : (
            <SectionState s={deployments} />
          )}
        </Accordion>
        <Accordion title="Errors" open={open === "errors"} onToggle={() => toggle("errors")}>
          <ErrorsView project={project} version={version} />
        </Accordion>
        <Accordion title="Domains" hint={domains.data ? domains.data.domains.length : undefined} open={open === "domains"} onToggle={() => toggle("domains")}>
          {domains.data ? (
            domains.data.domains.length === 0 ? (
              <Note>No domains on this project.</Note>
            ) : (
              <ul className="supa-list compact">
                {domains.data.domains.map((d) => (
                  <li key={d.name}>
                    <span className="truncate grow" title={d.name}>
                      {d.name}
                    </span>
                    {d.redirect && <span className="small muted">→ {d.redirect}</span>}
                    <span className={`small ${d.verified && d.configured !== false ? "supa-on" : "supa-off"}`}>{!d.verified ? "not verified" : d.configured === false ? "DNS not set" : "ok"}</span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <SectionState s={domains} />
          )}
          <Note>Buying a domain or changing DNS is done by you in Vercel.</Note>
        </Accordion>
        <Accordion title="Env" hint={env.data ? env.data.vars.length : undefined} open={open === "env"} onToggle={() => toggle("env")}>
          {env.data ? (
            env.data.vars.length === 0 ? (
              <Note>No environment variables.</Note>
            ) : (
              <ul className="supa-list compact">
                {env.data.vars.map((v) => (
                  <li key={v.key}>
                    <code className="truncate grow vcl-key" title={v.key}>
                      {v.key}
                    </code>
                    <span className="small muted">{v.targets.join(", ") || "—"}</span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <SectionState s={env} />
          )}
          <Note>Names only: values are never loaded. Add or change them in Vercel.</Note>
        </Accordion>
      </ul>
      <a className="small supa-open" href={vercelDashboardUrl(link)} target="_blank" rel="noopener noreferrer">
        Open in Vercel <ExternalLink size={ICON_SM} strokeWidth={STROKE} aria-hidden />
      </a>
    </div>
  );
}
