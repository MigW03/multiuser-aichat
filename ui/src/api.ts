import type {
  AcceptInviteResponse,
  ApiError,
  AssignableRole,
  AiEditState,
  ChatGptPollResponse,
  ChatGptStartResponse,
  ChatGptUsage,
  ImageUrlsResponse,
  FolderListResult,
  GitStatusResult,
  GitTextResult,
  FolderReadResult,
  OpenRouterUsage,
  InvitePreview,
  KeysResponse,
  McpRemoteAuthInput,
  McpRemoteList,
  McpRemoteServer,
  ModelsResponse,
  PendingInvite,
  ProviderId,
  SendMessageRequest,
  SendMessageResponse,
  SmartSet,
  SmartSettings,
  SummarizeRequest,
} from "@mc/shared";
import { config } from "./config.ts";
import { supabase } from "./supabase.ts";

/** An error from the chat server with a message that is safe to show, and the server's short code when it has one. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) headers.authorization = `Bearer ${token}`;
  else if (opts.auth !== false) throw new ApiRequestError("You are signed out.", 401);
  let res: Response;
  try {
    res = await fetch(`${config.serverUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiRequestError("Could not reach the chat server. Is it running?", 0);
  }
  const json = (await res.json().catch(() => ({}))) as T & Partial<ApiError> & { code?: string };
  if (!res.ok) throw new ApiRequestError(json.error ?? `Request failed (${res.status})`, res.status, json.code);
  return json;
}

/** POSTs a file as the request body. Same errors as `call`. */
async function sendFile<T>(path: string, file: Blob): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiRequestError("You are signed out.", 401);
  let res: Response;
  try {
    res = await fetch(`${config.serverUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": file.type || "application/octet-stream" }, body: file });
  } catch {
    throw new ApiRequestError("Could not reach the chat server. Is it running?", 0);
  }
  const json = (await res.json().catch(() => ({}))) as T & Partial<ApiError>;
  if (!res.ok) throw new ApiRequestError(json.error ?? `Request failed (${res.status})`, res.status);
  return json;
}

export type InviteRow = Omit<PendingInvite, "token"> & { link: string };
export type InviteCreated = { id: string; link: string; expires_at: string; emailed: boolean };

export const api = {
  // Remote MCP servers (connected tools the chat server calls for you; secrets are write-only)
  mcpServers: () => call<McpRemoteList>("GET", "/api/mcp/servers"),
  mcpAdd: (body: { name: string; url: string; auth: McpRemoteAuthInput }) => call<McpRemoteServer>("POST", "/api/mcp/servers", body),
  mcpSet: (id: string, body: { enabled?: boolean; tool?: { name: string; enabled: boolean } }) => call<McpRemoteServer>("PATCH", `/api/mcp/servers/${id}`, body),
  mcpToken: (id: string, value: string) => call<McpRemoteServer>("PUT", `/api/mcp/servers/${id}/token`, { value }),
  mcpDelete: (id: string) => call<{ ok: true }>("DELETE", `/api/mcp/servers/${id}`),
  mcpRetry: (id: string) => call<McpRemoteServer>("POST", `/api/mcp/servers/${id}/retry`),
  mcpSignIn: (id: string) => call<{ url: string | null }>("POST", `/api/mcp/servers/${id}/oauth/start`),
  mcpSignOut: (id: string) => call<McpRemoteServer>("POST", `/api/mcp/servers/${id}/signout`),
  keys: () => call<KeysResponse>("GET", "/api/keys"),
  saveKey: (provider: ProviderId, apiKey: string) => call<{ hint: string }>("PUT", `/api/keys/${provider}`, { apiKey }),
  deleteKey: (provider: ProviderId) => call<{ ok: true }>("DELETE", `/api/keys/${provider}`),
  models: (provider: ProviderId) => call<ModelsResponse>("GET", `/api/models/${provider}`),
  chatgptStart: () => call<ChatGptStartResponse>("POST", "/api/chatgpt/start", {}),
  openrouterUsage: (refresh = false) => call<OpenRouterUsage>("GET", `/api/openrouter/usage${refresh ? "?refresh=1" : ""}`),
  chatgptUsage: (refresh = false) => call<ChatGptUsage>("GET", `/api/chatgpt/usage${refresh ? "?refresh=1" : ""}`),
  chatgptPoll: (flow: string) => call<ChatGptPollResponse>("POST", "/api/chatgpt/poll", { flow }),

  /** Smart model selection: this person's set of models for Auto, and their own switch for a project. */
  smartSet: () => call<SmartSet>("GET", "/api/smart/set"),
  saveSmartSet: (models: string[]) => call<SmartSet>("PUT", "/api/smart/set", { models }),
  smartSettings: (projectId: string, check = false) => call<SmartSettings>("GET", `/api/projects/${projectId}/smart${check ? "?check=1" : ""}`),
  setSmart: (projectId: string, enabled: boolean) => call<SmartSettings>("PUT", `/api/projects/${projectId}/smart`, { enabled }),

  createProject: (name: string) => call<{ id: string }>("POST", "/api/projects", { name }),
  renameProject: (id: string, name: string) => call<{ ok: true }>("PATCH", `/api/projects/${id}`, { name }),
  reorderProjects: (ids: string[]) => call<{ ok: true }>("PUT", "/api/projects/order", { ids }),
  deleteProject: (id: string) => call<{ ok: true }>("DELETE", `/api/projects/${id}`),
  keyStatus: (projectId: string) => call<{ hasKey: Record<string, boolean> }>("GET", `/api/projects/${projectId}/key-status`),
  setRole: (projectId: string, userId: string, role: AssignableRole) => call<{ ok: true }>("PATCH", `/api/projects/${projectId}/members/${userId}`, { role }),
  removeMember: (projectId: string, userId: string) => call<{ ok: true }>("DELETE", `/api/projects/${projectId}/members/${userId}`),
  inviteToProject: (projectId: string, email: string, role: AssignableRole) => call<InviteCreated>("POST", `/api/projects/${projectId}/invites`, { email, role }),
  projectInvites: (projectId: string) => call<{ invites: InviteRow[] }>("GET", `/api/projects/${projectId}/invites`),

  /** With `fromMessage`, the server has the AI retitle the note from that message's question and answer, using `provider`/`model`. */
  addNote: (projectId: string, body: { title: string; body: string; fromMessage?: string; provider?: string; model?: string }) => call<{ id: string }>("POST", `/api/projects/${projectId}/notes`, body),
  updateNote: (projectId: string, noteId: string, body: { title: string; body: string }) => call<{ ok: true }>("PATCH", `/api/projects/${projectId}/notes/${noteId}`, body),
  deleteNote: (projectId: string, noteId: string) => call<{ ok: true }>("DELETE", `/api/projects/${projectId}/notes/${noteId}`),

  /** The host or an admin answers a member's request to share something. */
  decideShare: (projectId: string, shareId: string, approve: boolean) => call<{ ok: true }>("POST", `/api/projects/${projectId}/shares/${shareId}/decision`, { approve }),
  /** Stops sharing one item: its owner, the host or an admin. */
  removeShare: (projectId: string, shareId: string) => call<{ ok: true }>("DELETE", `/api/projects/${projectId}/shares/${shareId}`),
  folderList: (projectId: string, path: string) => call<FolderListResult>("GET", `/api/projects/${projectId}/folder/list?${new URLSearchParams({ path })}`),
  /** Whether the AI can propose file edits in this project right now. */
  folderAi: (projectId: string) => call<{ edit: AiEditState }>("GET", `/api/projects/${projectId}/folder/ai`),
  folderRead: (projectId: string, path: string) => call<FolderReadResult>("GET", `/api/projects/${projectId}/folder/read?${new URLSearchParams({ path })}`),

  /** Read-only git for the project (404 with code git_off when no owner has switched git on). */
  gitStatus: (projectId: string) => call<GitStatusResult>("GET", `/api/projects/${projectId}/folder/git/status`),
  gitDiff: (projectId: string, path: string, target: "worktree" | "staged" | "head" = "head") =>
    call<GitTextResult>("GET", `/api/projects/${projectId}/folder/git/diff?${new URLSearchParams({ path, target })}`),

  createChat: (projectId: string | null) => call<{ id: string }>("POST", "/api/chats", { projectId }),
  renameChat: (id: string, title: string) => call<{ title: string }>("PATCH", `/api/chats/${id}`, { title }),
  deleteChat: (id: string) => call<{ ok: true }>("DELETE", `/api/chats/${id}`),
  inviteToChat: (chatId: string, email: string) => call<InviteCreated>("POST", `/api/chats/${chatId}/invites`, { email }),
  chatInvites: (chatId: string) => call<{ invites: InviteRow[] }>("GET", `/api/chats/${chatId}/invites`),
  sendMessage: (chatId: string, body: SendMessageRequest) => call<SendMessageResponse>("POST", `/api/chats/${chatId}/messages`, body),
  /** Uploads one picture (the file itself). The id is the client's, so the message that carries it can show it at once. */
  uploadImage: (chatId: string, id: string, file: Blob) => sendFile<{ id: string }>(`/api/chats/${chatId}/images?${new URLSearchParams({ id })}`, file),
  imageUrls: (chatId: string, ids: string[]) => call<ImageUrlsResponse>("POST", `/api/chats/${chatId}/images/urls`, { ids }),
  summarize: (chatId: string, body: SummarizeRequest & { fromSeq?: number }) => call<{ id: string }>("POST", `/api/chats/${chatId}/summarize`, body),
  stop: (chatId: string) => call<{ stopped: boolean }>("POST", `/api/chats/${chatId}/stop`, {}),
  retry: (messageId: string) => call<{ ok: true }>("POST", `/api/messages/${messageId}/retry`, {}),

  previewInvite: (token: string) => call<InvitePreview>("GET", `/api/invites/${token}`, undefined, { auth: false }),
  acceptInvite: (token: string) => call<AcceptInviteResponse>("POST", `/api/invites/${token}/accept`, {}),
  revokeInvite: (id: string) => call<{ ok: true }>("DELETE", `/api/invites/${id}`),
};
