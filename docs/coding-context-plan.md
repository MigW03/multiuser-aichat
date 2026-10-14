# Shared coding context: implementation plan

Status: **proposal, nothing implemented yet** (first written 2026-10-13, revised the same day).

Based on reading two open-source projects:
- **OpenCode** `v2` branch ([anomalyco/opencode](https://github.com/anomalyco/opencode/tree/v2), MIT), mainly `packages/core/src/session/`, for how an AI conversation's context is managed;
- **Zed** ([zed-industries/zed](https://github.com/zed-industries/zed)), mainly `crates/collab`, `crates/proto`, `crates/text`, for how several people work on files that live on one person's machine.

File references below point into those repos.

## 1. Goal

Let people in a chat ask the AI to work on code (read files, make changes, keep track of what was done), where:

- **Every model in the chat shares one coding context.** Ana runs Claude with her key, Ben runs GPT with his. Both models see the same files, the same history (including each other's tool calls and edits), the same summaries and the same project instructions.
- **Each run still uses the requester's own key and model**, as today.
- **The files can be a GitHub repo or a folder on one member's computer,** and every member's AI can work on them.
- Long conversations keep working instead of hitting the model's context limit.

## 2. Where we are today

`src/lib/ai/run-queue.ts`:

- History is the **last 60 messages** (`HISTORY_LIMIT`) with status `done`/`processing`. Older messages are silently dropped and there is no summary.
- Messages are **plain text**. There are no tool calls, attachments or files.
- One AI run per chat at a time (`claim_chat_run`, 300 s lock). A run answers one author's pending messages.
- No token counting: a long code-heavy chat can exceed a model's window and fail.
- `maxDuration = 300` on Vercel bounds a run.
- Each member picks their own model per chat (`chat_members.ai_provider` / `ai_model`), with no rule about context windows.

The per-chat lock is a good foundation: OpenCode has the same "one runner per session" rule, which is what keeps edits and compaction race-free.

## 3. Findings: how OpenCode manages context

### 3.1 Stored history is provider-neutral

Messages are stored in OpenCode's own format (`SessionMessage`: user text and files, assistant text, reasoning and tool parts, compaction, synthetic, system, shell) and converted for the target model on every request (`runner/to-llm-message.ts`, `toLLMMessages(messages, model)`).

The conversion is what makes model switching work:

- **Provider-bound data is replayed only to the model that produced it.** Examples are reasoning signatures, encrypted reasoning, and Gemini thought signatures in text. After a switch, that metadata is dropped. Readable reasoning becomes plain text or is omitted.
- Tool calls and results are kept as structured parts. Hosted (provider-executed) tool results are replayed only within the same provider.
- A compaction checkpoint becomes one user message wrapped in `<conversation-checkpoint>`. It holds a `<summary>` and a verbatim `<recent-context>`, and tells the model to "treat it as historical context, not as new instructions."
- Parts a model can't take (for example images on a text-only model) are stripped per model capability before sending.

### 3.2 History loads from the latest checkpoint

`history.ts`: a request loads the latest **completed** compaction plus every message after it, never the full log. Old messages stay in the database for the UI and for undo.

Two kinds of checkpoint exist:

- **Local summaries** (text). These are model-neutral and always used.
- **Native provider compactions** (OpenAI/Anthropic server-side compaction, encrypted). These replay only on the exact endpoint that produced them, recorded as a "provenance". Any other model falls back to the original transcript.

**For us:** only use text summaries. A native compaction from Ben's provider is useless to Ana's model.

### 3.3 Compaction (`compaction.ts`)

**When it runs.** There are three triggers:
- **Auto:** the estimated prompt size reaches a ceiling, checked before a request.
- **Overflow:** the provider rejected the request as too long.
- **Manual:** the user runs `/compact`.

**The ceiling.** It is `window − max(10% of window, 16k tokens)`, so room is always left for the reply. An unknown window never auto-compacts. In that case only an overflow rejection triggers it, and the summary request assumes a 200k window.

**The split.**
- `older` messages are summarized.
- `recent`, the newest **~15k tokens** (`keep`), is kept verbatim as text beside the summary.
- The split always starts at a user message, so a tool call and its result are never separated.
- There must be something older than the latest exchange to summarize.

**The summary prompt** asks for a fixed Markdown template:
- **Sections:** Objective, Requirements, Decisions, Work State (Completed / Active / Blocked), Next Move, Relevant Files (at most 15), Important Context.
- **Preserve exactly:** file paths, symbols, commands, error strings, URLs and identifiers.
- **Carry forward only unresolved requests,** keeping their wording.
- **Keep workflow state** (uncommitted, committed, pushed, merged).
- **Leave out** instruction files and environment details, which are re-sent fresh anyway.
- **Don't mention** that the context was compacted.

**Updating a checkpoint.** Later compactions get the previous checkpoint plus everything since, and update it. Newer history wins, completed work moves out of Active, and stale items may be removed. The result is one rolling summary, not a chain of them.

**Validation.** If the reply doesn't contain the template headings, the model gets one nudge ("fill in the template, no tools"). A second miss is a failure.

**Making the summary request fit.**
- The summary request is sized to the budget. Tool outputs inside it are cut to **1,250 characters** and media is replaced by placeholders.
- Whole exchanges are dropped oldest-first, with an `[N older exchanges omitted]` note.
- If the provider still says "too long", the next attempts aim at **70%, then 50%, then 35%** of the rejected size, then it gives up.

**Cost.** Each compaction model call is billed and recorded like a normal reply.

### 3.4 Token accounting

- The provider-reported usage of the **latest assistant reply** is the measured anchor. That is input, cache read, cache write, output and reasoning tokens.
- Anything after it is estimated at **~4 characters per token** (`util/token.ts`), about **1,500 tokens per image** and **2,000 per PDF**.
- **Measurements from a different provider are not trusted** (`hasMeasuredPrompt`), because tokenizers and windows differ. That matters when Ana's and Ben's runs alternate.

### 3.5 Bounded tools

- **Every tool result** is capped at **2,000 lines / 50 KB** (`tool-output.ts`). The full output is saved to a file kept for 7 days, and the model gets `[showing lines 1-N of M; full output saved to <path>]`.
- **`read`** returns line-numbered text, at most 2,000 lines per call, with `offset`/`limit` and a "continue with offset: N" hint. Its description says to prefer one larger read over many small ones and to use grep for large files.
- **`edit`** is an exact `oldString` → `newString` replacement that must match once unless `replaceAll` is set. It fails loudly when there is no match and returns a structured diff. **`write`** creates or replaces whole files.
- **Subagents** (`tool/plugin/subagent.ts`) run a task in a child session with fresh context and return only the final answer. This keeps big explorations out of the main context.

### 3.6 Instructions and prompt caching

`context.ts` assembles instruction sources in a fixed order, **from most to least shared**: tool catalog → MCP → references → skills → discovered project files (AGENTS.md and similar) → built-ins → session entries. Its comment puts user-level guidance first, then project instructions, then the date and environment, which change by day and folder. The stable part stays a reusable prompt-cache prefix.

- **Epochs** (`instruction-state.ts`). A baseline of instructions is frozen at the start of an epoch. Changes during the conversation are appended as chronological `system` update messages instead of rewriting the prefix, so the cache isn't broken. A completed compaction starts a new epoch with a fresh baseline.
- **Nested instructions** (`instructions.ts`). An instruction file in a subfolder is injected once, as a synthetic message, the first time the agent touches that folder. A ledger in the message metadata prevents duplicates. If compaction drops it, it gets re-injected later.
- **The system prompt** (`runner/prompt/system.txt` + `system-prompt.ts`) is short, adds tool-specific guidance only for tools that are enabled, and has per-model-family variants.

### 3.7 Snapshots and undo

`snapshot.ts` captures the workspace as a content-addressed tree in a shadow git repo **before local tools run** in each step. `revert.ts` restores the files changed after a chosen message and keeps the original so the revert itself can be undone. `diff.ts` produces per-file diffs for the UI.

### 3.8 The run loop

`runner/step.ts`:
- **Order of operations:** start the snapshot, then stream the model and run tool calls as they arrive. Each tool output is bounded and then recorded.
- **Overflow:** a "too long" rejection compacts and retries the step.
- **Step limit:** when it's reached, tools are disabled (`toolChoice: none`) and the model is told to summarize what it did, what is left and what to do next (`runner/max-steps.ts`).
- **Persistence:** each step is persisted, so a run can resume from history.

## 4. Findings: how Zed shares one person's files with others

Zed's collaboration has three parts: the **host** (whose machine has the files), the **collab server** (`crates/collab`, a long-running service at collab.zed.dev), and **guests**. They talk over websockets using protobuf messages (`crates/proto/proto/*.proto`).

### 4.1 Files stay on the host

- **Sharing.** The host sends the project's file tree to the server: paths, sizes, modified times, ignored flags, **no file contents** (`worktree.proto`, `Entry`). It keeps sending incremental updates as files change. The server stores that tree in Postgres, so a joining guest gets it immediately (`rpc.rs`, `share_project`, `update_worktree`, `join_project`).
- **Opening a file.** A guest's `OpenBufferByPath` request is forwarded by the server to the host. The host reads the file and streams its state back to the guest (`CreateBufferForPeer`). File contents pass through the server and are never stored there.
- **Saving.** `SaveBuffer` is forwarded to the host, and only the host writes to disk.

### 4.2 The server is a relay plus a permission check

`collab/src/rpc.rs` registers every project request as either:
- **read-only** (`forward_read_only_project_request`): open a file, search, symbols, git info. Any project member may send these;
- **mutating** (`forward_mutating_project_request`): save, create, rename or delete a file, format, rename a symbol. Read-only guests are refused.

Buffer edits (`update_buffer`) are checked per operation. Cursor and selection updates need only read access, and anything that changes text needs write access. Allowed edits are broadcast to the other guests and forwarded to the host.

### 4.3 Concurrent typing uses a CRDT

Several people can type in the same file at the same moment, so `crates/text` implements a CRDT, which merges concurrent edits identically on every machine:
- **Every edit is tagged** with its author (`ReplicaId`), a Lamport clock and a version vector (`buffer.proto`, `Operation.Edit`).
- **Insertions are never moved.** Text is a sequence of fragments, and deleted text is marked invisible rather than removed, so late edits still find their anchor (`text.rs`, `Fragment`).
- **Out-of-order edits wait.** An edit that depends on one not yet received is queued (`deferred_ops`).
- **Reconnects are cheap.** Machines exchange versions and send only what's missing (`SynchronizeBuffers`).
- **Undo is its own replicated operation.**

### 4.4 AI in a shared project

A guest's AI agent runs **on the guest's machine, with the guest's own AI settings**. Its tools use the same remote-project layer, so they read and edit the host's files through the server. Zed's channel docs list "use AI features" among what works in someone else's project. AI edits have their own author ID, `ReplicaId::AGENT` (`crates/clock`), so they can be told apart from human edits.

### 4.5 Trust

Zed's collaboration docs warn that sharing a project gives collaborators access to your local file system within that project, and to only collaborate with people you trust. Channel guests get a read-only view, and members can edit.

## 5. Design for our app

### 5.1 Principles

1. **Context belongs to the chat, not the user.** History, checkpoints, workspace, instructions, undo state and the context window are chat-scoped. Only the key and model are per run.
2. **Store model-neutral, convert per request.** Anything model-specific is tagged with the provider and model that produced it, and dropped when another model reads it.
3. **Bound everything.** Tool outputs, file reads and history all have explicit budgets based on the chat's agreed context window.
4. **One writer per chat.** Keep the existing per-chat lock. Compaction and edits happen only inside it.
5. **Files live where their owner keeps them.** That's GitHub for a repo, or the owner's own machine for a local folder (Zed-style). Our server relays and checks permissions, and stores code only when it must.

### 5.2 Agreed context window per chat

**Problem:** if each run budgets for its own model, a 1M-token model and a 200k model in the same chat fight each other.
- **Ana's 1M runs never compact,** so history grows to, say, 600k tokens.
- **Ben's 200k model then has to summarize it all.** That summary request can't fit, so the oldest conversation is dropped and detail is lost.
- **Ana's model then receives that compressed summary too.**
- **It repeats,** and requests above about 200k tokens also cost more at some providers.

**Rule: a chat has one agreed context window, and a member's model must have a window at least that large.**

- **What it is:** `chats.context_window`, for example 1,000,000 or 200,000, shown in the chat header. Every run in the chat budgets and compacts against it (5.5), whichever model is used.
- **Default:** the window of the creator's first model. If you want to use 1M models, a chat where everyone has a 1M model stays at 1M.
- **The picker:**
  - models whose window is at least the chat window can be picked freely;
  - picking a smaller model doesn't switch immediately. It **proposes lowering the chat window**: "Ben wants to switch to X (200k). This would lower the chat's context window to 200k."
- **Approval:** every other member gets an Approve / Decline request. It's saved in the database, so a member who was offline sees it when they return, and it's also broadcast live.
  - **Approved:** the chat window becomes the smaller value, the proposer's model switches, and one compaction runs to fit the new window (5.5).
  - **Declined, or cancelled by the proposer:** nothing changes, and the proposer keeps their current model.
- **Members with larger models don't have to switch.** Ana's 1M model keeps working, just within the chat's 200k window. (A stricter alternative is that everyone switches to a smaller model, see open questions. It isn't needed for consistency.)
- **Raising the window** also needs every member's approval, because a bigger shared history makes everyone's runs cost more. It's only possible when every member's current model supports the new size.
- **Unknown window sizes:** OpenRouter's `/models` reports `context_length`. Anthropic's and OpenAI's model lists may not, so keep a small table of known windows. A model with an unknown window can't join a chat with a set window until we know its size; the member can pick another model.

### 5.3 Where the files live

There are two workspace sources, plus a later sandbox:

| Source | How | Pros | Cons |
|---|---|---|---|
| **Cloud workspace** (GitHub-backed) | Import a repo branch. Reads come from GitHub, AI edits live in an overlay in our database and Storage, and "Open PR" commits them to a branch | Works when nobody is online, fully serverless, human-reviewed output | Needs a GitHub connection; uncommitted local work isn't visible |
| **Local workspace** (Zed-style companion) | A member's companion app (the planned desktop app) shares a folder. Every member's AI reads and edits it through our server, live | Real local files, including uncommitted work, with no git step | The owner must be online; the biggest trust step |
| **Sandbox** (later) | Vercel Sandbox (`@ai-sdk/sandbox-vercel`) with a real filesystem and shell | Can run tests, installs and builds | Cost, cold starts, lifecycle |

Build the **cloud workspace first**. Add the **local workspace** with the desktop app, and the **sandbox** when we need to run code. The installed AI SDK v7 supports sandboxes through `experimental_sandbox` (`node_modules/ai/docs/03-agents/04-loop-control.mdx`).

#### Local workspace: how it works (borrowed from Zed)

```
 Ana's machine                    our server (Next.js API + Supabase)               Ben's run
 ┌────────────────────┐ Realtime ┌───────────────────────────────────┐   tool    ┌──────────────┐
 │ companion app      │◄────────►│ relay + permission check          │◄──────────│ Ben's model  │
 │ shared folder only │          │ workspace_entries (tree, no code) │   calls   │ (Ben's key)  │
 │ applies edits      │          │ edit log, approvals               │           └──────────────┘
 └────────────────────┘          └───────────────────────────────────┘
```

- **Sharing.** Ana shares one folder from the companion and picks **read-only** or **read-write** for the chat. Like Zed, the companion uploads the file tree (paths, sizes, modified times, ignored flags) into `workspace_entries`, and keeps it updated. File contents are not stored on our server.
- **Transport.** Vercel functions can't hold websockets, but Supabase Realtime can. The companion stays subscribed to a private channel for the workspace. A tool call becomes a request message with an id; the companion replies on the same channel, and the waiting run times out if there's no answer (for example after 20 s).
- **Permissions are checked on the server,** as in Zed's read-only and mutating split:
  - `list`, `read`, `grep` and `glob` are allowed in read-only and read-write shares;
  - `edit`, `write`, `delete` and `rename` only in read-write shares.

  The companion checks again locally. It refuses paths outside the shared folder and never touches `.env`-like files or `.git`.
- **Edits.** Before applying, the companion creates a git checkpoint (or keeps a copy of the file), then writes. Every edit is logged with the requester, the model and the chat message: "GPT edited `src/x.ts` for Ben". That's our version of Zed's `ReplicaId::AGENT`, used for review and undo.
- **Conflicts without a CRDT.** In our app edits come from AI tool calls, and the per-chat lock lets only one run edit at a time. So a hash check is enough. `read` returns the file's hash, and `edit` sends the hash it expects. If Ana changed the file in her own editor meanwhile, the edit fails with "file changed, read it again". A CRDT (an existing library such as Yjs, not our own) becomes necessary only if we add a live shared editor in the browser.
- **Approval on the owner's side (optional).** Ana can set "ask me before edits from other members' AI" or "auto-apply". With "ask", the run pauses until she approves, using the same approval mechanism as 5.2.
- **Offline.** If the companion isn't connected, tools return "Ana's machine is offline", and the model tells the requester. Ana can switch the workspace to a cloud copy (push a branch and import it) if work needs to continue without her.

### 5.4 Storage

Stay on **Supabase Postgres**, plus **Supabase Storage** for large text. No second database:
- **SQLite** (OpenCode's choice) needs a local disk, which Vercel doesn't have, so it would mean a hosted variant and another vendor.
- **MongoDB:** Postgres `jsonb` covers flexible message parts. A second database would lose row-level security tied to our logins, Realtime, and transactions that save a file change, its message and its version together.

The rule is **small records in Postgres, large text in Storage**:
- **Version contents and full tool outputs** go in Storage, keyed by content hash, so identical versions are stored once. Postgres holds only path, hash, size and who and when.
- **Local workspaces store no code at all,** only the tree and the edit log. Diffs shown in the chat are kept as small records for display and undo.
- **Code search** uses Postgres's trigram text search (`pg_trgm`) for cloud workspaces, and the companion's own search for local ones.

### 5.5 Data model (sketch)

```sql
-- Agreed context window and pending changes to it.
alter table chats add column context_window integer;  -- tokens; every run budgets against this

create table chat_window_proposals (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats on delete cascade,
  proposed_by uuid not null references profiles,
  new_window integer not null,
  provider text not null, model text not null,          -- the model that prompted the change
  status text not null check (status in ('pending','approved','declined','cancelled')),
  approvals uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

-- Model-neutral message content: AI SDK-style parts instead of a single text column.
alter table messages
  add column parts jsonb,          -- [{type:'text'|'tool-call'|'tool-result'|'reasoning', ..., producedBy:{provider, model}}]
  add column usage jsonb;          -- provider-reported tokens for assistant replies (anchor for estimates)

-- Rolling summary checkpoints (one active per chat).
create table chat_checkpoints (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats on delete cascade,
  covers_through_seq bigint not null,  -- messages with seq <= this are summarized
  summary text not null,
  recent text not null,                -- verbatim recent context kept beside the summary
  status text not null check (status in ('running','completed','failed')),
  created_by uuid references profiles, -- whose run (and key) produced it
  provider text, model text, usage jsonb,
  created_at timestamptz not null default now()
);

-- One workspace per chat to start.
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null unique references chats on delete cascade,
  kind text not null check (kind in ('cloud','local')),
  source jsonb,          -- cloud: {repo, branch, base_sha}; local: {owner_id, folder_name}
  access text not null default 'read' check (access in ('read','write')),  -- what other members' AI may do
  approve_edits boolean not null default false,  -- local: owner approves each edit
  instructions text      -- AGENTS.md-style project notes, editable by members
);

create table workspace_entries (     -- file tree (both kinds); no contents
  workspace_id uuid references workspaces on delete cascade,
  path text not null, is_dir boolean not null, size bigint, mtime timestamptz, ignored boolean default false,
  primary key (workspace_id, path)
);

create table workspace_edits (       -- every AI edit: review, diff display, undo
  id bigint generated always as identity primary key,
  workspace_id uuid references workspaces on delete cascade,
  message_id uuid references messages,
  requested_by uuid references profiles, provider text, model text,
  path text not null, op text not null check (op in ('edit','write','delete','rename')),
  before_hash text, after_hash text,  -- contents in Storage (cloud) or on the owner's machine (local)
  diff text,                          -- bounded, for display
  created_at timestamptz default now()
);

create table tool_outputs (          -- pointers to full outputs in Storage, deleted after ~7 days
  id uuid primary key default gen_random_uuid(),
  chat_id uuid references chats on delete cascade,
  storage_path text not null, bytes integer, created_at timestamptz default now()
);
```

Cloud workspaces also need an overlay of changed files (path, content hash, `base_sha`), which `workspace_edits` plus Storage can provide. All tables need RLS so that only chat members can read them. Writes happen only from the server, inside the run.

### 5.6 Building a request for one run

For run R with requester U, using U's key and model M (whose window is at least the chat window):

1. **Load:** the latest completed `chat_checkpoints` row, plus `messages` with `seq > covers_through_seq`.
2. **Convert** with `toModelMessages(history, M)`:
   - keep the `[Name]:` attribution on user messages (we already do this);
   - render the checkpoint as a `<conversation-checkpoint>` user message;
   - **drop provider metadata and reasoning produced by a different provider or model**;
   - normalize tool-call ids to `[A-Za-z0-9_-]{1,64}`;
   - merge consecutive same-role messages (we already do this);
   - strip parts M can't accept.
3. **System prompt:** the static harness prompt and tool guidance first, then workspace instructions, then the chat participants and date. That order keeps the stable part cacheable.
4. **Estimate** the size: the last assistant `usage` from **the same provider as M** if there is one, plus about 4 characters per token for everything after it.
5. **Compact if needed:** compare against `ceiling(chat.context_window)` = `window − max(10%, 16k)`, using the **chat's** window rather than M's.
6. **Run** the agent loop (5.8). If a step overflows anyway, compact and retry, shrinking as in 3.3.

### 5.7 Compaction in a shared, multi-model chat

- **One checkpoint per chat, shared by every model.** It's plain text, and every allowed model's window is at least the chat window, so every model can read it, and any member's model can produce it.
- **Billing:** the compaction call runs with the requester's key and model, consistent with "each person pays for their own messages".
- **Lowering the window** (5.2) needs one compaction from a history that may be bigger than the proposer's model can hold. It's done **in chunks** with the proposer's model and key: summarize about the first 150k tokens, then update that checkpoint with the next chunk, and so on. OpenCode's "update the existing checkpoint" prompt is designed for this. The approval request shows the estimated cost.
- **Template:** OpenCode's template with two multi-user changes:
  - **Participants:** who is in the chat and what each person is working on.
  - **Open requests:** unresolved requests **with the requester's name** and exact wording.
  - Keep the rest: Objective, Decisions, Work State, Next Move, Relevant Files, Important Context. Keep workflow state such as "edits not yet exported", "PR #12 open" or "Ana's workspace offline".
- **Show it in the UI:** a divider saying "Earlier messages summarized". Anyone can expand the summary, and old messages stay visible.
- **Manual compaction:** a `/compact` action for chat members.

### 5.8 Tools and the agent loop

| Tool | Behavior | Limits |
|---|---|---|
| `list` | Directory listing from `workspace_entries` | 2,000 entries, paged |
| `read` | Line-numbered content with `offset`/`limit`, plus the file hash | 2,000 lines per call, "continue at offset N" |
| `grep` / `glob` | Search paths and content (`pg_trgm` for cloud, companion for local) | Capped matches |
| `edit` | Exact `oldString` → `newString`, unique unless `replaceAll`, with the expected hash | Fails on no match or a changed file; logs to `workspace_edits` and returns a diff |
| `write` | Create or replace a whole file | Logged like `edit` |
| `run_command` (later) | Shell in the sandbox | Output bounded like every tool |

The same tools work on cloud and local workspaces, and only the backend differs.
- **Bounding:** every result passes through one function that caps it at 2,000 lines / 50 KB and stores the full text in Storage.
- **Path safety:** paths are relative to the workspace root, and `..`, absolute paths, `.git` and `.env`-like files are refused.
- **Names and schemas:** tool names use `[a-z_]` only, and the schemas are identical for every provider, so any model can continue another model's work.

**The loop.** The installed AI SDK v7 already covers most of this (`node_modules/ai/docs/03-agents/04-loop-control.mdx`):
- `streamText` with tools and `stopWhen: stepCountIs(N)` bound the number of steps;
- `prepareStep` can replace `messages` before each step, which is where mid-run compaction hooks in;
- `activeTools` / `toolChoice: 'none'` handle the "step limit reached: summarize with text only" behavior;
- `onStepFinish` / `totalUsage` let us persist each step and its usage.

**The 300-second limit.** A coding run with many steps, or waiting on an owner's approval, can exceed it. Persist after every step, and if time runs low or the run is waiting on approval, stop cleanly and re-queue the run from the stored history. If that gets complicated, move to `WorkflowAgent` (`@ai-sdk/workflow`), which is durable and has approvals that survive suspension.

**Queueing:** today a run takes one author's pending messages, and that stays the same. Other members' messages wait in the queue during a long run.

### 5.9 Visibility and undo

- **Tool activity in the chat,** for example "Claude read `src/app/page.tsx`" or "GPT edited 2 files for Ben", with an expandable diff. All members see the same thing.
- **Revert to before a message:**
  - cloud workspaces restore from `workspace_edits` and Storage;
  - local workspaces ask the companion to restore its checkpoint.

  Either way, the revert can itself be undone.
- **Exporting a cloud workspace to GitHub is always a human action** ("Open PR"), never a tool. Check `base_sha` against the branch first.

### 5.10 Prompt caching

Keep the system prompt and instructions byte-stable and first. Append instruction changes as messages rather than rewriting the prefix, and re-baseline at compaction (OpenCode's epochs).
- **OpenAI** caches automatically.
- **Anthropic** needs explicit cache breakpoints, through provider options in the AI SDK.
- **OpenRouter** passes caching through to the underlying provider where supported.

## 6. Multi-model checklist

| Risk when several models share one history | Mitigation |
|---|---|
| Different context windows (1M vs 200k) | Agreed chat window; smaller models need every member's approval (5.2) |
| Lowering the window with a history bigger than the new model can hold | Chunked compaction with the proposer's model (5.7) |
| Provider-specific reasoning or signatures rejected or misread by another provider | Tag parts with `producedBy`; replay metadata only to the same model; drop reasoning for other models |
| Tool-call id format rejected | Normalize ids when converting |
| Provider-native compaction can't be replayed elsewhere | Never use it; use text checkpoints only |
| Token counts not comparable across providers | Trust measured usage only from the same provider; otherwise estimate |
| A model can't accept images or PDFs | Strip or replace unsupported parts per model |
| Same tool behaving differently per provider | One tool set, one schema, server-executed tools only |
| Model confusion about who asked what | `[Name]:` prefixes, and requester names in checkpoint open requests |

## 7. Security and privacy

- **Local workspaces are the biggest trust step:** other members' prompts change files on the owner's disk. Mitigations:
  - an explicit share of one folder, read-only by default;
  - path checks on the server and again in the companion;
  - no `.env` or `.git` access, and no shell;
  - a checkpoint before every edit, an edit log, and optional per-edit approval.
- **Prompt injection:** file contents and tool outputs are untrusted. The system prompt should say so, and tools can never touch keys, env files or other chats.
- **Shared visibility:** every chat member's AI, and so every member's provider, sees the workspace. Say this in the UI when a repo or folder is shared.
- **Realtime channels** for a workspace are private, and only the owner's companion and our server can use them.
- **GitHub access:** a GitHub App or OAuth token scoped to the chosen repo, stored encrypted like the API keys (`src/lib/crypto.ts`). Export as a PR only, never a push to the default branch.
- **Storage:** version contents and tool outputs can contain code and secrets. Protect them with RLS and Storage policies, and expire tool outputs.
- **Cost:** compaction, chunked compaction and tool loops spend the requester's key. Show per-run usage and the cost estimate on window-change approvals, and enforce a step limit.

## 8. Phased plan

0. **Groundwork, useful even without coding:**
   - store `parts` and `usage` on messages;
   - add the agreed chat window with proposals and approvals, and a known-windows table;
   - replace the 60-message limit with budgeting against the chat window;
   - add checkpoints and compaction, including the chunked mode;
   - show a "summarized" divider in the UI.
1. **Cloud workspace with read-only tools:** import a GitHub branch, plus `list`, `read`, `grep` and workspace instructions. The AI can explain code but not change it.
2. **Edit tools:** `edit` and `write`, with `workspace_edits`, diffs in the chat, revert-to-message, and "Open PR".
3. **Local workspace:** the companion in the desktop app, folder sharing with read-only or read-write access, Realtime request and reply, hash-checked edits, and optional owner approval.
4. **Sandbox:** `run_command` for tests and builds, via Vercel Sandbox.
5. **Durability and scale:** step persistence with continuation or `WorkflowAgent`, and subagents for large explorations.

## 9. Open questions

- **Who approves window changes** once chats allow up to 5 members: everyone, or the chat creator?
- **Strict or relaxed window rule:** after a lower window is approved, must larger-model members also switch to a smaller model (strict), or keep their model within the window (current plan)?
- **Unknown windows:** block the model, or let the member declare the size?
- **Who may share a local folder or connect a repo, and who may export a PR:** any member, or only the owner or creator?
- **Default for local workspaces:** read-only plus per-edit approval, or read-write with auto-apply?
- **Step limit per run** (OpenCode makes it configurable): 25? 50?

## 10. Sources read

**OpenCode** (`packages/core/src/`):
- `session/`: `compaction.ts`, `history.ts`, `context.ts`, `runner/to-llm-message.ts`, `runner/step.ts`, `runner/index.ts`, `runner/max-steps.ts`, `runner/prompt/system.txt`, `system-prompt.ts`, `instructions.ts`, `instruction-state.ts`, `provider-context.ts`, `usage.ts`, `revert.ts`;
- `tool-output.ts`, `snapshot.ts`, `util/token.ts`, `tool/AGENTS.md`, `tool/plugin/{read,edit,write,subagent}.ts`, `config/plugin/compaction.ts`, and the `session_context_epoch` migrations.

**Zed:**
- `crates/collab/README.md` and `crates/collab/src/rpc.rs` (`share_project`, `join_project`, `update_worktree`, `update_buffer`, `forward_read_only_project_request`, `forward_mutating_project_request`);
- `crates/proto/proto/{buffer,worktree,ai}.proto`;
- `crates/text/src/text.rs` (`Fragment`, `deferred_ops`) and `crates/clock/src/clock.rs` (`ReplicaId::AGENT`);
- `crates/agent/src/tools/{edit_file_tool,terminal_tool}.rs`, `crates/agent_ui/src/thread_metadata_store.rs`;
- `docs/src/collaboration/{overview,channels}.md`.
