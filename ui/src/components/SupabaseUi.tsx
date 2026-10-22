import {
  SUPABASE_LOG_SOURCES,
  SUPABASE_LOG_WINDOWS,
  SUPABASE_MCP_URL,
  type ProjectSummary,
  type SupabaseCheck,
  type SupabaseLink,
  type SupabaseLogSource,
  type SupabaseProjectOption,
  type SupabaseSection,
  type SupabaseSectionData,
} from "@mc/shared";
import { ChevronDown, ChevronRight, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, ApiRequestError } from "../api.ts";
import { useApp } from "../data.tsx";
import { notifySupabaseChanged, type SupabaseHook } from "../lib/supabaseState.ts";
import { Button, Dialog, ErrorLine, ICON_SM, IconButton, Spinner, STROKE, useToast } from "./kit.tsx";

// The Supabase tab of the Files card, and the dialog that links a Nido project to a Supabase project (opened from Project
// settings). The tab only reads: every number, name and log line comes from Supabase through the asking person's own
// connection, as plain text. Changes to Supabase go through chat, where the AI asks first.

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : "Something went wrong. Try again.");
const dashboardUrl = (ref: string) => `https://supabase.com/dashboard/project/${encodeURIComponent(ref)}`;
const openExternal = (url: string | null | undefined) => {
  if (url && /^https:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer"); // the desktop app hands https pages to the system browser
};

/** "13 MB", "512 KB". */
export function formatBytes(n: number | null): string {
  if (n === null) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** A migration's version is its time, "20261022114118": shown as "2026-10-22". */
export function migrationDate(version: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(version);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : version;
}

// ------------------------------------------------------------------------------------------------ connecting

/** Adds the Supabase entry to this person's MCP servers (when there is none) and starts its sign-in in the browser. */
export function useConnectSupabase(sup: SupabaseHook) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async (id: string) => {
    const { url } = await api.mcpSignIn(id);
    openExternal(url);
    sup.watch();
    await sup.reload();
    notifySupabaseChanged();
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
    clearError: () => setError(null),
    /** No entry yet: add it, then sign in. An entry that needs a sign-in: sign in. */
    connect: () =>
      run(async () => {
        let id = sup.state?.mine.serverId;
        if (!id) {
          for (const name of ["supabase", "supabase-2", "supabase-3"]) {
            try {
              id = (await api.mcpAdd({ name, url: SUPABASE_MCP_URL, auth: { kind: "oauth" } })).id;
              break;
            } catch (e) {
              if (e instanceof ApiRequestError && /already have a server/i.test(e.message)) continue; // that name is taken by another entry
              throw e;
            }
          }
          if (!id) throw new Error("Could not add Supabase. Try again.");
        }
        await signIn(id);
      }),
    retry: () =>
      run(async () => {
        const id = sup.state?.mine.serverId;
        if (!id) return;
        await api.mcpRetry(id);
        sup.watch();
        await sup.reload();
      }),
    turnOn: () =>
      run(async () => {
        const id = sup.state?.mine.serverId;
        if (!id) return;
        await api.mcpSet(id, { enabled: true });
        sup.watch();
        await sup.reload();
        notifySupabaseChanged();
      }),
  };
}

type DialogMode = "link" | "change" | "setup";

/** Link a Supabase project to this Nido project: 1 Connect (only if Supabase is not set up yet), 2 Choose. "setup" is only step 1, for someone who just wants to see a project that is already linked. */
export function LinkSupabaseDialog({ project, sup, mode, onClose }: { project: ProjectSummary; sup: SupabaseHook; mode: DialogMode; onClose: () => void }) {
  const toast = useToast();
  const state = sup.state;
  const mine = state?.mine.state ?? "none";
  const ready = mine === "ready";
  const connect = useConnectSupabase(sup);
  const [asked, setAsked] = useState(false); // the person pressed Connect or Sign in: now we wait for them to finish in the browser
  const [projects, setProjects] = useState<SupabaseProjectOption[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const step = !ready ? 1 : mode === "setup" ? 3 : 2;
  const current = state?.link?.ref ?? null;

  useEffect(() => {
    if (step !== 3) return;
    toast.push("Supabase is set up. The tab is in the Files card.");
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => {
    if (step !== 2) return;
    let live = true;
    setProjects(null);
    setListError(null);
    api.supabaseProjects(project.id).then(
      (r) => {
        if (!live) return;
        setProjects(r.projects);
        setPick((p) => p ?? r.projects.find((x) => x.ref !== current)?.ref ?? null);
      },
      (e) => live && setListError(messageOf(e)),
    );
    return () => {
      live = false;
    };
  }, [step, project.id, reload, current]);

  const link = async () => {
    if (!pick) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.supabaseLink(project.id, pick);
      notifySupabaseChanged();
      toast.push(mode === "change" ? "Supabase project changed." : "Supabase tab added to Files.");
      onClose();
    } catch (e) {
      setSaveError(messageOf(e));
      setSaving(false);
    }
  };

  const labels = mode === "setup" ? ["1 Connect"] : ["1 Connect", "2 Choose"];
  const title = mode === "change" ? "Change Supabase project" : mode === "setup" ? "Set up Supabase" : "Link a Supabase project";

  let body: ReactNode;
  let footer: ReactNode = <Button onClick={onClose}>Cancel</Button>;
  if (!state) {
    body = <Spinner />;
  } else if (step === 1) {
    const waiting = asked && (mine === "needs_sign_in" || mine === "connecting");
    body = (
      <>
        {mine === "none" && <p>Supabase is not connected on your account yet. Connecting adds it to your MCP servers, read-only.</p>}
        {mine === "needs_sign_in" && !waiting && <p>Sign in to Supabase to go on.</p>}
        {mine === "failed" && <p>Could not connect to Supabase{state.mine.error ? `: ${state.mine.error}` : "."}</p>}
        {mine === "off" && <p>Supabase is turned off in your MCP servers.</p>}
        {mine === "connecting" && !waiting && (
          <p>
            <Spinner /> Connecting to Supabase…
          </p>
        )}
        {waiting && (
          <p className="supa-wait">
            <span className="mdot connecting" aria-hidden /> Waiting for the Supabase sign-in… Finish it in the browser window. This moves on by itself.
          </p>
        )}
        {!state.oauthAvailable && (mine === "none" || mine === "needs_sign_in") && <p className="small muted">Signing in to Supabase is not set up on this chat server.</p>}
        {mine === "none" && <p className="small muted">Opens the Supabase sign-in in your browser. Your own Supabase account; read-only.</p>}
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
            Connect Supabase
          </Button>
        )}
        {mine === "needs_sign_in" && (
          <Button variant="primary" busy={connect.busy} disabled={!state.oauthAvailable} onClick={() => void go(connect.connect)}>
            {waiting ? "Open sign-in again" : "Sign in to Supabase"}
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
            <p>No Supabase projects in this account.</p>
            <p className="small muted">Create one in Supabase, then come back.</p>
          </>
        ) : (
          <>
            <fieldset className="supa-pick">
              <legend className="small muted">Your Supabase projects</legend>
              {projects.map((p) => (
                <label key={p.ref} className={`supa-pick-row ${pick === p.ref ? "on" : ""}`}>
                  <input type="radio" name="supabase-project" checked={pick === p.ref} disabled={p.ref === current} onChange={() => setPick(p.ref)} />
                  <span className="supa-pick-text">
                    <span className="strong">{p.name}</span>
                    <span className="small muted">
                      {[p.region, p.status ? p.status.toLowerCase().replace(/_/g, " ") : "", p.ref === current ? "linked now" : ""].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            <p className="small muted">Everyone in {project.name} will see the project's name and region. What they see inside comes from their own Supabase account.</p>
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
            <Button onClick={() => openExternal("https://supabase.com/dashboard/projects")}>Open Supabase</Button>
            <Button variant="primary" onClick={() => setReload((n) => n + 1)}>
              Refresh list
            </Button>
          </>
        ) : (
          <Button variant="primary" busy={saving} disabled={!pick || projects === null} onClick={() => void link()}>
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

type Loaded<S extends SupabaseSection> = { data: SupabaseSectionData[S] | null; error: { message: string; code?: string } | null; loading: boolean; reload: () => void };

/** One section of the linked project, read when `enabled` and again when `version` changes. */
function useSection<S extends SupabaseSection>(projectId: string, section: S, q: { source?: string; minutes?: number; errors?: boolean }, enabled: boolean, version: number): Loaded<S> {
  const [data, setData] = useState<SupabaseSectionData[S] | null>(null);
  const [error, setError] = useState<Loaded<S>["error"]>(null);
  const [loading, setLoading] = useState(false);
  const [again, setAgain] = useState(0);
  const key = JSON.stringify(q);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true);
    setError(null);
    api.supabaseData(projectId, section, JSON.parse(key) as typeof q).then(
      (r) => live && setData(r.data),
      (e) => live && setError({ message: messageOf(e), ...(e instanceof ApiRequestError && e.code ? { code: e.code } : {}) }),
    ).finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, section, enabled, version, again, key]);
  return { data, error, loading, reload: () => setAgain((n) => n + 1) };
}

function Accordion({ title, hint, open, onToggle, children }: { title: string; hint?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <li className="supa-sec">
      <button type="button" className="supa-sec-head" aria-expanded={open} onClick={onToggle}>
        {open ? <ChevronDown size={ICON_SM} strokeWidth={STROKE} aria-hidden /> : <ChevronRight size={ICON_SM} strokeWidth={STROKE} aria-hidden />}
        <span className={open ? "strong" : ""}>{title}</span>
        <span className="grow" />
        {hint !== undefined && hint !== null && <span className="small muted">{hint}</span>}
      </button>
      {open && <div className="supa-sec-body">{children}</div>}
    </li>
  );
}

const Note = ({ children }: { children: ReactNode }) => <p className="small muted supa-note">{children}</p>;

function SectionState({ s, empty }: { s: Loaded<SupabaseSection>; empty?: string }) {
  if (s.loading && !s.data) return <Spinner />;
  if (s.error) return <ErrorLine>{s.error.message}</ErrorLine>;
  return empty ? <Note>{empty}</Note> : null;
}

const levelClass = (l: SupabaseCheck["level"]) => (l === "INFO" ? "info" : l === "WARN" ? "warn" : "bad");

function ChecksList({ items }: { items: SupabaseCheck[] }) {
  if (items.length === 0) return <Note>Nothing to fix. Supabase's checks found no problems.</Note>;
  return (
    <ul className="supa-list">
      {items.map((c, i) => (
        <li key={`${c.kind}-${c.title}-${i}`}>
          <span className={`supa-level ${levelClass(c.level)}`}>{c.level}</span>
          <span className="supa-item-text">
            <span>
              {c.title}
              {c.count > 1 ? ` (${c.count})` : ""}
            </span>
            {c.detail && <span className="small muted supa-clamp">{c.detail}</span>}
            {c.url && (
              <a className="small" href={c.url} target="_blank" rel="noopener noreferrer">
                Fix guide ↗
              </a>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

const SOURCE_LABEL: Record<SupabaseLogSource, string> = {
  postgres_logs: "Database",
  edge_logs: "API requests",
  auth_logs: "Auth",
  auth_audit_logs: "Auth audit",
  postgrest_logs: "PostgREST",
  realtime_logs: "Realtime",
  pgbouncer_logs: "Pooler",
  function_edge_logs: "Function requests",
  function_logs: "Function output",
  storage_logs: "Storage",
};
const WINDOW_LABEL: Record<number, string> = { 15: "15 min", 60: "1 hour", 360: "6 hours", 1440: "24 hours" };

function LogsView({ projectId, version }: { projectId: string; version: number }) {
  const [source, setSource] = useState<SupabaseLogSource>("postgres_logs");
  const [minutes, setMinutes] = useState<number>(60);
  const [errors, setErrors] = useState(false);
  const [applied, setApplied] = useState<{ source: SupabaseLogSource; minutes: number; errors: boolean } | null>(null);
  const [wide, setWide] = useState<number | null>(null);
  // Logs are only read when asked: the first Load, and each Load after. Never on a timer.
  const s = useSection(projectId, "logs", applied ?? {}, applied !== null, version);
  const load = () => {
    setApplied({ source, minutes, errors });
    if (applied && applied.source === source && applied.minutes === minutes && applied.errors === errors) s.reload();
  };
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return minutes <= 360 ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  return (
    <>
      <div className="supa-controls">
        <select className="input" aria-label="Log source" value={source} onChange={(e) => setSource(e.target.value as SupabaseLogSource)}>
          {SUPABASE_LOG_SOURCES.map((x) => (
            <option key={x} value={x}>
              {SOURCE_LABEL[x]}
            </option>
          ))}
        </select>
        <select className="input" aria-label="Time window" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {SUPABASE_LOG_WINDOWS.map((m) => (
            <option key={m} value={m}>
              {WINDOW_LABEL[m]}
            </option>
          ))}
        </select>
        <label className="small supa-check">
          <input type="checkbox" checked={errors} onChange={(e) => setErrors(e.target.checked)} /> Errors only
        </label>
        <Button size="sm" variant="primary" busy={s.loading} onClick={load}>
          Load
        </Button>
      </div>
      {applied === null ? (
        <Note>Logs are read when you press Load.</Note>
      ) : s.loading && !s.data ? (
        <Spinner />
      ) : s.error ? (
        <ErrorLine>{s.error.message}</ErrorLine>
      ) : s.data && s.data.rows.length === 0 ? (
        <Note>No log lines in that window.</Note>
      ) : (
        <ul className="supa-logs">
          {s.data?.rows.map((r, i) => (
            <li key={`${r.time}-${i}`}>
              <button type="button" className={`supa-log ${wide === i ? "wide" : ""}`} onClick={() => setWide(wide === i ? null : i)} aria-expanded={wide === i}>
                <span className="supa-log-time">{fmt(r.time)}</span>
                <span className="supa-log-text">{r.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function CopyRow({ label, value, shown }: { label: string; value: string; shown?: string }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.push(`${label} copied.`);
    } catch {
      toast.push("Could not copy. Select the text instead.", "error");
    }
  };
  return (
    <div className="supa-copy">
      <span className="small muted">{label}</span>
      <code className="truncate">{shown ?? value}</code>
      <IconButton label={`Copy ${label}`} className="sm" onClick={() => void copy()}>
        <Copy size={ICON_SM} strokeWidth={STROKE} aria-hidden />
      </IconButton>
    </div>
  );
}

const healthDot = (status: string) => (status === "ACTIVE_HEALTHY" ? "ready" : /PAUSED|INACTIVE|GOING_DOWN|REMOVED/.test(status) ? "signin" : status === "" ? "off" : "connecting");

export function SupabaseBody({ project, sup }: { project: ProjectSummary; sup: SupabaseHook }) {
  const state = sup.state;
  const connect = useConnectSupabase(sup);
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
      "Sign in to Supabase to see this project.",
      <div>
        <Button size="sm" variant="primary" busy={connect.busy} disabled={!state.oauthAvailable} onClick={() => void connect.connect()}>
          Sign in to Supabase
        </Button>
      </div>,
    );
  if (mine.state === "failed")
    return msg(
      `Could not connect to Supabase${mine.error ? `: ${mine.error}` : "."}`,
      <div>
        <Button size="sm" variant="primary" busy={connect.busy} onClick={() => void connect.retry()}>
          Try again
        </Button>
      </div>,
    );
  if (mine.state === "off")
    return msg(
      "Supabase is turned off in your MCP servers.",
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
          <Spinner /> Connecting to Supabase…
        </p>
      </div>
    );
  return <ReadyBody project={project} link={link} />;
}

function ReadyBody({ project, link }: { project: ProjectSummary; link: SupabaseLink }) {
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const overview = useSection(project.id, "overview", {}, true, version);
  const checks = useSection(project.id, "checks", {}, true, version);
  const tables = useSection(project.id, "tables", {}, open === "tables", version);
  const migrations = useSection(project.id, "migrations", {}, open === "migrations", version);
  const functions = useSection(project.id, "functions", {}, open === "functions", version);
  const connectInfo = useSection(project.id, "connect", {}, open === "connect", version);
  const toggle = (id: string) => setOpen((cur) => (cur === id ? null : id));
  const o = overview.data;

  // The first read decides what the person sees: no access to the project, or the Supabase connection needs them.
  if (overview.error && !o) {
    const code = overview.error.code;
    return (
      <div className="side-card-body supa-body">
        <p className="small">{code === "no_access" ? `Your Supabase account has no access to “${link.name}”.` : overview.error.message}</p>
        <div className="supa-actions">
          <Button size="sm" onClick={() => setVersion((n) => n + 1)}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => openExternal(dashboardUrl(link.ref))}>
            Open in Supabase <ExternalLink size={ICON_SM} strokeWidth={STROKE} aria-hidden />
          </Button>
        </div>
      </div>
    );
  }

  const warn = checks.data ? checks.data.items.filter((c) => c.level !== "INFO").length : null;
  const summary = o ? [o.region || link.region, o.postgres ? `Postgres ${o.postgres}` : "", formatBytes(o.dbBytes), o.authUsers !== null ? `${o.authUsers} ${o.authUsers === 1 ? "user" : "users"}` : ""].filter(Boolean).join(" · ") : "";

  return (
    <div className="side-card-body supa-body">
      <div className="supa-head">
        <span className={`mdot ${o ? healthDot(o.status) : "connecting"}`} role="img" aria-label={o ? o.status.toLowerCase().replace(/_/g, " ") || "status unknown" : "Loading"} />
        <b className="truncate" title={link.name}>
          {link.name}
        </b>
        <span className="supa-pill" title="This tab only reads. Changes to Supabase go through chat, where the AI asks first.">
          read-only
        </span>
        <IconButton label="Refresh" className="sm" onClick={() => setVersion((n) => n + 1)}>
          <RefreshCw size={ICON_SM} strokeWidth={STROKE} aria-hidden />
        </IconButton>
      </div>
      {o ? <p className="small muted supa-summary">{summary}</p> : overview.loading ? <Spinner /> : null}
      {o && /PAUSED|INACTIVE/.test(o.status) && <p className="small supa-paused">This project is paused in Supabase. Ask the AI to restore it, or restore it in Supabase.</p>}
      <ul className="supa-secs">
        <Accordion title="Checks" hint={checks.loading && !checks.data ? "…" : warn === null ? undefined : warn === 0 ? "ok" : `${warn} to fix`} open={open === "checks"} onToggle={() => toggle("checks")}>
          {checks.data ? <ChecksList items={checks.data.items} /> : <SectionState s={checks} />}
        </Accordion>
        <Accordion title="Tables" hint={o?.tables ?? undefined} open={open === "tables"} onToggle={() => toggle("tables")}>
          {tables.data ? (
            tables.data.tables.length === 0 ? (
              <Note>No tables in the public schema.</Note>
            ) : (
              <ul className="supa-list compact">
                {tables.data.tables.map((t) => (
                  <li key={t.name}>
                    <span className="supa-item-text grow">
                      <span className="truncate">{t.name}</span>
                    </span>
                    {t.rows !== null && <span className="small muted">{t.rows} rows</span>}
                    <span className={`small ${t.rls ? "supa-on" : "supa-off"}`} title={t.rls ? "Row level security is on" : "Row level security is off: anyone with the API key can read this table"}>
                      {t.rls ? "RLS on" : "RLS off"}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <SectionState s={tables} />
          )}
        </Accordion>
        <Accordion title="Migrations" hint={o?.migrations ?? undefined} open={open === "migrations"} onToggle={() => toggle("migrations")}>
          {migrations.data ? (
            migrations.data.migrations.length === 0 ? (
              <Note>No migrations yet.</Note>
            ) : (
              <ul className="supa-list compact">
                {migrations.data.migrations.map((m) => (
                  <li key={m.version}>
                    <span className="small muted supa-date">{migrationDate(m.version)}</span>
                    <span className="truncate">{m.name}</span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <SectionState s={migrations} />
          )}
        </Accordion>
        <Accordion title="Logs" open={open === "logs"} onToggle={() => toggle("logs")}>
          <LogsView projectId={project.id} version={version} />
        </Accordion>
        <Accordion title="Functions" hint={functions.data ? functions.data.functions.length : undefined} open={open === "functions"} onToggle={() => toggle("functions")}>
          {functions.data ? (
            functions.data.functions.length === 0 ? (
              <Note>No edge functions yet.</Note>
            ) : (
              <ul className="supa-list compact">
                {functions.data.functions.map((f) => (
                  <li key={f.slug}>
                    <span className="truncate grow">{f.name || f.slug}</span>
                    <span className="small muted">{f.status.toLowerCase()}</span>
                    {f.version !== null && <span className="small muted">v{f.version}</span>}
                  </li>
                ))}
              </ul>
            )
          ) : (
            <SectionState s={functions} />
          )}
        </Accordion>
        <Accordion title="Connect" open={open === "connect"} onToggle={() => toggle("connect")}>
          {connectInfo.data ? (
            <>
              {connectInfo.data.url && <CopyRow label="API URL" value={connectInfo.data.url} />}
              {connectInfo.data.publishableKey && <CopyRow label="Publishable key" value={connectInfo.data.publishableKey} shown={`${connectInfo.data.publishableKey.slice(0, 16)}••••`} />}
              <p className="small muted supa-note">Extensions on: {connectInfo.data.extensions.length ? connectInfo.data.extensions.join(", ") : "none"}</p>
            </>
          ) : (
            <SectionState s={connectInfo} />
          )}
        </Accordion>
      </ul>
      <a className="small supa-open" href={dashboardUrl(link.ref)} target="_blank" rel="noopener noreferrer">
        Open in Supabase <ExternalLink size={ICON_SM} strokeWidth={STROKE} aria-hidden />
      </a>
    </div>
  );
}

/** Used by the settings page: the link as text. */
export const linkText = (l: SupabaseLink) => `${l.name}${l.region ? ` (${l.region})` : ""}`;
export { dashboardUrl as supabaseDashboardUrl };
