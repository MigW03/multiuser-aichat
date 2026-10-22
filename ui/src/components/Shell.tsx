import { DEFAULT_REASONING, type ModelChoice, type Person, type ProviderId } from "@mc/shared";
import { SearchX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api } from "../api.ts";
import {
  AppContext,
  fetchChatPeople,
  fetchChats,
  fetchMe,
  fetchProjectMembers,
  fetchProjects,
  useLive,
  useRealtimeLists,
  type AppContextValue,
  type Me,
} from "../data.tsx";
import { useFolderHost, useMcpHost, useProjectShares } from "../lib/folder.ts";
import { useNarrow, useProjectPresence } from "../lib/hooks.ts";
import { previewBridge } from "../lib/preview.ts";
import { clearPref, PREF, readPref, writePref } from "../lib/prefs.ts";
import { loadModels } from "../lib/models.ts";
import { navigate, useRoute } from "../lib/router.ts";
import { NEW_CHAT_SHORTCUT, PANEL_SHORTCUT } from "../lib/shortcuts.ts";
import { supabase } from "../supabase.ts";
import { ResetPassword } from "./Auth.tsx";
import { ChatView } from "./ChatView.tsx";
import { InviteDialog, type InviteTarget } from "./Dialogs.tsx";
import { Landing } from "./EmptyStates.tsx";
import { ApprovalDock } from "./Changes.tsx";
import { FilePanel, type FileRequest } from "./FilePanel.tsx";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { RightColumn } from "./FolderUi.tsx";
import { JoinSignedIn } from "./Join.tsx";
import { LeftPanel } from "./LeftPanel.tsx";
import { PanelResizer, useLeftWidth, useRightWidth } from "./PanelResizer.tsx";
import { clampPreviewWidth, PreviewPanel, PreviewResizer } from "./PreviewPanel.tsx";
import { defaultModelFor } from "./Pickers.tsx";
import { AddKeyDialog, SettingsDialog, type SettingsTab } from "./Settings.tsx";
import { Button, Spinner } from "./kit.tsx";

type InviteRequest = { kind: "project"; projectId: string } | { kind: "chat"; chatId: string };

export function Shell({ userId }: { userId: string }) {
  const route = useRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keys, setKeys] = useState<AppContextValue["keys"]>(null);
  const [stored, setStored] = useState<ModelChoice | null>(null);
  const [settings, setSettings] = useState<{ tab: SettingsTab; focus?: string } | null>(null);
  const [addKey, setAddKey] = useState(false);
  const [inviteReq, setInviteReq] = useState<InviteRequest | null>(null);

  useRealtimeLists(userId);

  const reloadMe = useCallback(() => {
    fetchMe(userId).then(
      (m) => {
        setMe(m);
        setLoadError(null);
      },
      (e: unknown) => setLoadError(e instanceof Error ? e.message : "Could not load your account."),
    );
  }, [userId]);
  const reloadKeys = useCallback(() => {
    api.keys().then(
      (r) => setKeys(r.keys),
      () => setKeys((cur) => cur ?? []),
    );
  }, []);

  useEffect(() => {
    reloadMe();
    reloadKeys();
  }, [reloadMe, reloadKeys]);

  // Someone who had to sign in or confirm their email first lands back on the invite they were opening.
  useEffect(() => {
    const pending = readPref<string | null>(PREF.pendingJoin, null);
    if (!pending) return;
    if (route.name === "join") return;
    if (/^[0-9a-f]{64}$/.test(pending)) navigate({ name: "join", token: pending }, { replace: true });
    else clearPref(PREF.pendingJoin);
    // only on first load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The model last used is remembered on the profile; it is only used while a key for its provider exists.
  const profileLoaded = useRef(false);
  useEffect(() => {
    if (!me || profileLoaded.current) return;
    profileLoaded.current = true;
    if (me.ai_provider && me.ai_model) setStored({ provider: me.ai_provider, model: me.ai_model, reasoning: me.ai_reasoning ?? DEFAULT_REASONING });
  }, [me]);

  const choice = stored && keys?.some((k) => k.provider === stored.provider) ? stored : null;

  const setChoice = useCallback(
    (c: ModelChoice) => {
      setStored(c);
      void supabase
        .from("profiles")
        .update({ ai_provider: c.provider, ai_model: c.model, ai_reasoning: c.reasoning })
        .eq("id", userId)
        .then(() => undefined);
    },
    [userId],
  );

  // With a key but no usable model pick (first key just added, or the old provider's key was removed), pick a sensible one.
  const autoPicked = useRef<ProviderId | null>(null);
  useEffect(() => {
    if (!me || !keys || keys.length === 0 || choice) return;
    const provider = keys[0]!.provider;
    if (autoPicked.current === provider) return;
    autoPicked.current = provider;
    let live = true;
    loadModels(provider).then(
      (models) => {
        const model = defaultModelFor(provider, models);
        if (live && model) setChoice({ provider, model, reasoning: stored?.reasoning ?? DEFAULT_REASONING });
      },
      () => {
        autoPicked.current = null;
      },
    );
    return () => {
      live = false;
    };
  }, [me, keys, choice, stored?.reasoning, setChoice]);

  const projectId = route.name === "project" ? route.projectId : null;
  const projects = useLive(fetchProjects, []);
  const chats = useLive(() => fetchChats(projectId), [projectId]);
  const members = useLive(() => (projectId ? fetchProjectMembers(projectId) : Promise.resolve(undefined)), [projectId]);
  const online = useProjectPresence(projectId, userId);
  // The desktop app serves what this person shares in the projects they belong to.
  useFolderHost(userId, projects.data?.map((p) => p.id));
  // And it runs this person's own connected tools (MCP servers) for the answers they ask for.
  useMcpHost(userId);

  const narrow = useNarrow();
  const [collapsed, setCollapsed] = useState(() => readPref(PREF.leftCollapsed(userId), false));
  const [drawer, setDrawer] = useState(false);
  const left = useLeftWidth(userId);
  const right = useRightWidth(userId);
  const activeChatId = route.name === "homeChat" ? route.chatId : route.name === "project" ? route.chatId : null;
  const settingsOpen = route.name === "project" && route.view === "settings";
  // On a small screen the list is the first thing you see until you open a chat.
  useEffect(() => {
    if (narrow) setDrawer(activeChatId === null && !settingsOpen);
  }, [narrow, activeChatId, settingsOpen, route.name, projectId]);

  // The right column (shared folder): open by default and remembered on wide screens; on a small screen a drawer that starts closed.
  const [folderPinned, setFolderPinned] = useState(() => readPref(PREF.folderOpen(userId), true));
  const [folderDrawer, setFolderDrawer] = useState(false);
  useEffect(() => setFolderDrawer(false), [narrow, projectId, activeChatId]);

  // The preview of a localhost page (desktop app only) shares the main panel with the chat. null: closed; url null: open, no address yet.
  const previewApi = useMemo(() => previewBridge(), []);
  const [preview, setPreview] = useState<{ url: string | null; full: boolean } | null>(null);
  const previewOpen = !!preview;
  const [previewStored, setPreviewStored] = useState<number | null>(() => readPref<number | null>(PREF.previewWidth(userId), null));
  const [mainRoom, setMainRoom] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => setPreview(null), [projectId]);

  // A shared file shows in the middle of the main panel in place of the chat (the chat stays mounted behind it). It and the
  // localhost preview never show together: opening one closes the other.
  const shares = useProjectShares(projectId);
  const activeShares = useMemo(() => (shares.data ?? []).filter((r) => r.status === "active"), [shares.data]);
  const shareFolders = useMemo(() => activeShares.filter((r) => r.kind === "dir").map((r) => r.name), [activeShares]);
  const [fileReq, setFileReq] = useState<FileRequest | null>(null);
  useEffect(() => setFileReq(null), [projectId, settingsOpen]);
  const closeFile = useCallback(() => setFileReq(null), []);
  const hasShares = activeShares.length > 0;
  const filesCtx = useMemo(
    () => ({
      hasAny: hasShares,
      path: fileReq && !fileReq.guess ? fileReq.path : null,
      open: (path: string, guess = false) => {
        setPreview(null);
        setFileReq((cur) => ({ path, guess, n: (cur?.n ?? 0) + 1 }));
        setFolderDrawer(false);
      },
      close: closeFile,
    }),
    [hasShares, fileReq, closeFile],
  );
  useEffect(() => {
    const el = mainRef.current;
    if (!el || !previewOpen || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setMainRoom(el.clientWidth));
    observer.observe(el);
    setMainRoom(el.clientWidth);
    return () => observer.disconnect();
  }, [previewOpen]);
  const previewCtx = useMemo(
    () => ({
      available: !!previewApi,
      open: previewOpen,
      show: (url?: string) => {
        if (!previewApi) return;
        setFileReq(null);
        setPreview((cur) => ({ url: url ?? cur?.url ?? null, full: cur?.full ?? false }));
      },
      close: () => setPreview(null),
    }),
    [previewApi, previewOpen],
  );

  // The files column steps aside while the preview is open beside the chat, and comes back when it closes.
  const folderOpen = narrow ? folderDrawer : folderPinned && !previewOpen;
  const toggleFolder = useCallback(() => {
    if (narrow) return setFolderDrawer((v) => !v);
    if (previewOpen) {
      setPreview(null);
      setFolderPinned(true);
      writePref(PREF.folderOpen(userId), true);
      return;
    }
    setFolderPinned((v) => {
      writePref(PREF.folderOpen(userId), !v);
      return !v;
    });
  }, [narrow, previewOpen, userId]);

  const setCollapsedPersisted = (v: boolean) => {
    setCollapsed(v);
    writePref(PREF.leftCollapsed(userId), v);
  };

  // Cmd+B (Ctrl+B off a Mac) shows or hides the left panel, also while typing; the browser's own meaning of the key is skipped.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!PANEL_SHORTCUT.matches(e) || e.repeat) return;
      e.preventDefault();
      if (narrow) setDrawer((d) => !d);
      else setCollapsedPersisted(!collapsed);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // setCollapsedPersisted only closes over userId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow, collapsed, userId]);

  // Cmd+N in the desktop app, Cmd+Shift+O everywhere: new chat, also while typing. Not under a dialog or menu, and on a
  // fresh chat it only puts the cursor in the message box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!NEW_CHAT_SHORTCUT.matches(e) || e.repeat || !me) return;
      e.preventDefault();
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')) return;
      const fresh = route.name === "home" || (route.name === "project" && route.draft && !route.view);
      if (fresh) {
        document.querySelector<HTMLTextAreaElement>(".composer-input textarea")?.focus();
        return;
      }
      if (route.name === "homeChat") navigate({ name: "home" });
      else if (route.name === "project") navigate({ name: "project", projectId: route.projectId, chatId: null, draft: true });
      else return;
      if (narrow) setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route, me, narrow]);

  const ctx = useMemo<AppContextValue | null>(
    () =>
      me && {
        me,
        reloadMe,
        keys,
        reloadKeys,
        choice,
        setChoice,
        openSettings: (tab = "account", focus) => setSettings({ tab, focus }),
        openAddKey: () => setAddKey(true),
        openInvite: (target) => setInviteReq(target),
        folderPanel: { open: folderOpen, drawer: narrow, toggle: toggleFolder },
        preview: previewCtx,
        files: filesCtx,
      },
    [me, reloadMe, keys, reloadKeys, choice, setChoice, folderOpen, narrow, toggleFolder, previewCtx, filesCtx],
  );

  if (route.name === "reset") return <ResetPassword />;
  if (loadError) {
    return (
      <div className="center-screen col" style={{ alignItems: "center", gap: 12 }}>
        <div className="error-line">{loadError}</div>
        <Button onClick={reloadMe}>Try again</Button>
      </div>
    );
  }
  if (!me || !ctx) {
    return (
      <div className="center-screen">
        <Spinner />
      </div>
    );
  }

  if (route.name === "join") {
    return (
      <AppContext.Provider value={ctx}>
        <JoinSignedIn token={route.token} userId={userId} />
      </AppContext.Provider>
    );
  }

  const project = projectId ? projects.data?.find((p) => p.id === projectId) ?? null : null;
  const projectMissing = !!projectId && projects.data !== undefined && !project;
  const chat = activeChatId ? chats.data?.find((c) => c.id === activeChatId) ?? null : null;
  const chatMissing = !!activeChatId && chats.data !== undefined && !chat;
  const showLeft = narrow ? drawer : !collapsed;

  let main;
  if (projectMissing) {
    main = <NotFound text="This project doesn't exist, or you're not in it." />;
  } else if (projectId && !project) {
    main = <Loading />;
  } else if (project && settingsOpen) {
    main = <ProjectSettings key={project.id} project={project} leftCollapsed={narrow || collapsed} onShowLeft={() => (narrow ? setDrawer(true) : setCollapsedPersisted(false))} />;
  } else if (activeChatId) {
    main = chatMissing ? (
      <NotFound text="This chat doesn't exist anymore, or you don't have access to it." back={project ? { name: "project", projectId: project.id, chatId: null } : { name: "home" }} />
    ) : chat ? (
      <ChatView
        key={chat.id}
        chat={chat}
        project={project}
        projectPeople={members.data as Person[] | undefined}
        projectOnline={online}
        leftCollapsed={narrow || collapsed}
        onShowLeft={() => (narrow ? setDrawer(true) : setCollapsedPersisted(false))}
      />
    ) : (
      <Loading />
    );
  } else {
    main = (
      <Landing
        key={project?.id ?? "home"}
        project={project}
        people={(members.data as Person[] | undefined) ?? []}
        hasChat={(chats.data?.length ?? 0) > 0}
        hasProject={(projects.data?.length ?? 0) > 0}
        leftCollapsed={narrow || collapsed}
        onShowLeft={() => (narrow ? setDrawer(true) : setCollapsedPersisted(false))}
      />
    );
  }

  return (
    <AppContext.Provider value={ctx}>
      <div className={`app ${narrow ? "narrow" : ""}`} style={narrow ? undefined : ({ "--left-width": `${left.width}px`, "--right-width": `${right.width}px` } as CSSProperties)}>
        {narrow && drawer && <div className="drawer-backdrop" onClick={() => activeChatId && setDrawer(false)} />}
        {showLeft && (
          <div className={narrow ? "drawer" : "left-slot"}>
            <LeftPanel
              project={project}
              projects={projects.data}
              chats={chats.data}
              members={members.data}
              online={online}
              activeChatId={activeChatId}
              onCollapse={() => (narrow ? setDrawer(false) : setCollapsedPersisted(true))}
              onNavigate={() => narrow && setDrawer(false)}
            />
            {!narrow && <PanelResizer width={left.width} max={left.max} onChange={left.set} />}
          </div>
        )}
        <main className={`main ${previewApi && preview && !narrow && !preview.full ? "with-preview" : ""}`} ref={mainRef}>
          {/* The chat stays mounted behind a full-size preview, so nothing typed or scrolled is lost. */}
          <div className={`main-slot ${(preview && (narrow || preview.full)) || (fileReq && project) ? "hidden" : ""}`}>{main}</div>
          {fileReq && project && (
            <div className="file-slot">
              <FilePanel projectId={project.id} request={fileReq} folders={shareFolders} onClose={closeFile} />
            </div>
          )}
          {previewApi && preview && (
            <div className={`preview-slot ${narrow || preview.full ? "full" : ""}`} style={narrow || preview.full ? undefined : { width: clampPreviewWidth(previewStored, mainRoom) }}>
              <PreviewPanel
                bridge={previewApi}
                url={preview.url}
                remembered={readPref<string | null>(PREF.previewUrl(userId, projectId), null)}
                full={preview.full}
                narrow={narrow}
                onNavigate={(url) => {
                  writePref(PREF.previewUrl(userId, projectId), url);
                  setPreview((cur) => (cur ? { ...cur, url } : cur));
                }}
                onFull={(full) => setPreview((cur) => (cur ? { ...cur, full } : cur))}
                onClose={() => setPreview(null)}
              />
              {!narrow && !preview.full && (
                <PreviewResizer
                  width={clampPreviewWidth(previewStored, mainRoom)}
                  room={mainRoom}
                  onChange={(next, remember) => {
                    const v = clampPreviewWidth(next, mainRoom);
                    setPreviewStored(v);
                    if (remember) writePref(PREF.previewWidth(userId), v);
                  }}
                />
              )}
            </div>
          )}
        </main>
        {project && folderOpen && (
          <>
            {narrow && <div className="drawer-backdrop" onClick={toggleFolder} />}
            <div className={narrow ? "drawer right" : "right-slot"}>
              <RightColumn project={project} onClose={toggleFolder} />
              {!narrow && <PanelResizer side="right" width={right.width} max={right.max} min={right.min} def={right.def} onChange={right.set} />}
            </div>
          </>
        )}
      </div>

      {settings && <SettingsDialog initialTab={settings.tab} focus={settings.focus} onClose={() => setSettings(null)} />}
      {addKey && <AddKeyDialog onClose={() => setAddKey(false)} />}
      {inviteReq && <InviteHost req={inviteReq} projects={projects.data} chats={chats.data} meId={userId} onClose={() => setInviteReq(null)} />}
      <ApprovalDock projectName={(id) => projects.data?.find((p) => p.id === id)?.name ?? "a project"} />
    </AppContext.Provider>
  );
}

function Loading() {
  return (
    <section className="chat-card">
      <div className="center-screen">
        <Spinner />
      </div>
    </section>
  );
}

function NotFound({ text, back }: { text: string; back?: Parameters<typeof navigate>[0] }) {
  return (
    <section className="chat-card">
      <div className="empty-chat">
        <span className="empty-icon" aria-hidden>
          <SearchX size={22} strokeWidth={1.75} />
        </span>
        <h2>Nothing here</h2>
        <p className="muted">{text}</p>
        <Button onClick={() => navigate(back ?? { name: "home" })}>Go back</Button>
      </div>
    </section>
  );
}

/** Works out the names the invite dialog needs, then shows it. */
function InviteHost({
  req,
  projects,
  chats,
  meId,
  onClose,
}: {
  req: InviteRequest;
  projects: { id: string; name: string }[] | undefined;
  chats: { id: string; title: string }[] | undefined;
  meId: string;
  onClose: () => void;
}) {
  const [others, setOthers] = useState<string[] | null>(req.kind === "chat" ? null : []);
  useEffect(() => {
    if (req.kind !== "chat") return;
    let live = true;
    fetchChatPeople(req.chatId).then(
      (p) => live && setOthers(p.filter((x) => x.id !== meId).map((x) => x.display_name)),
      () => live && setOthers([]),
    );
    return () => {
      live = false;
    };
  }, [req, meId]);

  if (others === null) return null;
  let target: InviteTarget;
  if (req.kind === "project") {
    target = { kind: "project", projectId: req.projectId, name: projects?.find((p) => p.id === req.projectId)?.name ?? "this project" };
  } else {
    target = { kind: "chat", chatId: req.chatId, name: chats?.find((c) => c.id === req.chatId)?.title ?? "this chat", others };
  }
  return <InviteDialog target={target} onClose={onClose} />;
}
