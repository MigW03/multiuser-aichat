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
import { useFolderHost } from "../lib/folder.ts";
import { useNarrow, useProjectPresence } from "../lib/hooks.ts";
import { clearPref, PREF, readPref, writePref } from "../lib/prefs.ts";
import { loadModels } from "../lib/models.ts";
import { navigate, useRoute } from "../lib/router.ts";
import { PANEL_SHORTCUT } from "../lib/shortcuts.ts";
import { supabase } from "../supabase.ts";
import { ResetPassword } from "./Auth.tsx";
import { ChatView } from "./ChatView.tsx";
import { InviteDialog, type InviteTarget } from "./Dialogs.tsx";
import { Landing } from "./EmptyStates.tsx";
import { RightColumn } from "./FolderUi.tsx";
import { JoinSignedIn } from "./Join.tsx";
import { LeftPanel } from "./LeftPanel.tsx";
import { PanelResizer, useLeftWidth } from "./PanelResizer.tsx";
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
  const [settings, setSettings] = useState<{ tab: SettingsTab } | null>(null);
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
  // The desktop app serves the shared folders of the projects this person hosts.
  useFolderHost(userId, projects.data?.filter((p) => p.my_role === "host").map((p) => p.id));

  const narrow = useNarrow();
  const [collapsed, setCollapsed] = useState(() => readPref(PREF.leftCollapsed(userId), false));
  const [drawer, setDrawer] = useState(false);
  const left = useLeftWidth(userId);
  const activeChatId = route.name === "homeChat" ? route.chatId : route.name === "project" ? route.chatId : null;
  // On a small screen the list is the first thing you see until you open a chat.
  useEffect(() => {
    if (narrow) setDrawer(activeChatId === null);
  }, [narrow, activeChatId, route.name, projectId]);

  // The right column (shared folder): open by default and remembered on wide screens; on a small screen a drawer that starts closed.
  const [folderPinned, setFolderPinned] = useState(() => readPref(PREF.folderOpen(userId), true));
  const [folderDrawer, setFolderDrawer] = useState(false);
  useEffect(() => setFolderDrawer(false), [narrow, projectId, activeChatId]);
  const folderOpen = narrow ? folderDrawer : folderPinned;
  const toggleFolder = useCallback(() => {
    if (narrow) return setFolderDrawer((v) => !v);
    setFolderPinned((v) => {
      writePref(PREF.folderOpen(userId), !v);
      return !v;
    });
  }, [narrow, userId]);

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

  const ctx = useMemo<AppContextValue | null>(
    () =>
      me && {
        me,
        reloadMe,
        keys,
        reloadKeys,
        choice,
        setChoice,
        openSettings: (tab = "account") => setSettings({ tab }),
        openAddKey: () => setAddKey(true),
        openInvite: (target) => setInviteReq(target),
        folderPanel: { open: folderOpen, drawer: narrow, toggle: toggleFolder },
      },
    [me, reloadMe, keys, reloadKeys, choice, setChoice, folderOpen, narrow, toggleFolder],
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
      <div className={`app ${narrow ? "narrow" : ""}`} style={narrow ? undefined : ({ "--left-width": `${left.width}px` } as CSSProperties)}>
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
        <main className="main">{main}</main>
        {project && folderOpen && (
          <>
            {narrow && <div className="drawer-backdrop" onClick={toggleFolder} />}
            <div className={narrow ? "drawer right" : "right-slot"}>
              <RightColumn project={project} onClose={toggleFolder} />
            </div>
          </>
        )}
      </div>

      {settings && <SettingsDialog initialTab={settings.tab} onClose={() => setSettings(null)} />}
      {addKey && <AddKeyDialog onClose={() => setAddKey(false)} />}
      {inviteReq && <InviteHost req={inviteReq} projects={projects.data} chats={chats.data} meId={userId} onClose={() => setInviteReq(null)} />}
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
