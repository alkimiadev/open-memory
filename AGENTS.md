# AGENTS.md

## Project

`@alkdev/open-memory` — an OpenCode plugin that gives agents access to their own session history, context window awareness, and compaction control.

## Repository

- **Git**: `git@git.alk.dev:alkdev/open-memory.git` (Gitea, mirrors to GitHub on release)
- **License**: MIT OR Apache-2.0
- **Runtime**: Bun
- **Language**: TypeScript (strict, ESM, verbatimModuleSyntax)
- **Linter**: Biome (`bun run lint`, `bun run format`)
- **Build**: `bun run build` → `dist/` (bun build + tsc declarations)

## Commands

```bash
bun run build        # bun build src/index.ts + tsc --emitDeclarationOnly
bun run typecheck    # tsc --noEmit
bun run lint         # biome check .
bun run format       # biome format --write .
bun run test         # bun test
```

**Always run** `bun run typecheck` and `bun run lint` after changes.

## Architecture

### Three Pillars

1. **Context Awareness** — tracks context window usage via SSE events, injects status into system prompts
2. **Session History** — read-only queries against OpenCode's SQLite DB using `bun:sqlite` (readonly mode)
3. **Compaction Management** — improved compaction prompt + on-demand compaction triggering

### Source Structure

```
src/
├── index.ts              # Plugin entry: hooks + tool registration
├── tools.ts              # Tool definitions (memory router + memory_compact)
├── context/
│   ├── tracker.ts        # SSE token tracking (per-session context usage)
│   └── thresholds.ts     # Threshold constants + ContextStatus type (single source of truth)
├── history/
│   ├── queries.ts        # bun:sqlite read-only query helper (lazy singleton)
│   ├── format.ts         # Markdown rendering for session/message output
│   └── search.ts         # LIKE-based full-text search across conversations
└── compaction/
    └── prompt.ts         # Compaction prompt template (self-continuity, not "for another agent")
```

### Plugin Hooks

| Hook | Purpose |
|------|---------|
| `experimental.session.compacting` | Replace default "summarize for another agent" with self-continuity prompt |
| `experimental.chat.system.transform` | Inject context % used + advisory into system prompt |
| `event` | Feed SSE events to ContextTracker |

### Tools (2)

| Tool | Purpose |
|------|---------|
| `memory` | Router for all read-only operations: summary, sessions, messages, search, compactions, context, plans, help. Call with `{tool: "help"}` to see available operations. |
| `memory_compact` | Trigger compaction via `ctx.client.session.summarize()` — kept separate because it's a mutation |

The `memory` tool dispatches to internal handlers by `tool` name, keeping the agent's visible tool count low (2 instead of 8) to minimize context bloat.

**Internal operations** (accessed via `memory({tool: "...", args: {...}})`):

| Operation | Purpose | Key args |
|-----------|---------|----------|
| help | Show available operations, or details for a specific one | tool (optional) |
| summary | Quick counts: projects, sessions, messages, todos | — |
| sessions | List recent sessions, optionally filtered by project | limit, projectPath |
| messages | Read messages from a specific session | sessionId, limit |
| search | Text search across all conversations (LIKE-based) | query, limit |
| compactions | List/read compaction checkpoints for a session | sessionId, read (1-based index) |
| context | Current context window usage (% , tokens, model, status) | — |
| plans | List or read saved plan files | read (filename) |

### Database Access

- Uses `bun:sqlite` native driver — no subprocess, no `sqlite3` CLI dependency
- **Read-only**: `new Database(path, { readonly: true, create: false })`
- Connection is lazy-initialized and cached (singleton)
- All queries use `db.prepare(sql).all(params)` — never string interpolation
- DB path: `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db`

### Context Tracking

- Listens to `message.updated` SSE events for assistant messages
- `tokens.input` on the latest assistant message = current context size
- Compares against model's context limit from config
- Thresholds: green (<70%), yellow (70-85%), red (85-92%), critical (>92%)
- System prompt injection at yellow/red thresholds with advisory

### Context Percentage Calculation

From OpenCode source (`overflow.ts`):
```
count = tokens.total || (input + output + cache.read + cache.write)
reserved = config.compaction?.reserved ?? min(20000, maxOutputTokens)
usable = model.limit.input ? model.limit.input - reserved
                        : model.limit.context - maxOutputTokens
```

The `tokens.input` on the last assistant message approximates context size. We track against model context limit from config, falling back to 200k.

### Compaction Data in DB

When compaction occurs, OpenCode creates:
1. A synthetic `user` message with a `compaction`-type part (`part.data = {type: "compaction", auto: true/false, overflow: true/false}`)
2. `message.data.summary = {diffs: [...]}` on the compaction message
3. The assistant message immediately after contains the actual summary text in a `text`-type part

The `compactions` operation queries for `compaction`-type parts and retrieves the adjacent summary text, presenting them as navigable checkpoints.

### Write Operations

All write operations (compaction triggering) go through the OpenCode client SDK (`ctx.client.session.summarize`). The plugin never writes to the database or any OpenCode files.

**`memory_compact` must NOT await `ctx.client.session.summarize()`** — it returns immediately and schedules via `setTimeout(() => { ... }, 0)` because compaction cannot start until the tool returns control to the event loop.

## Key Conventions

- No comments unless requested
- ESM with `.js` extension in imports
- `bun:sqlite` for all database queries (never spawn `sqlite3`)
- Parameterized queries only (never interpolate user input into SQL)
- Read-only DB access — writes go through the SDK
- Strict TypeScript with `verbatimModuleSyntax`
- Biome for linting and formatting

## Relationship to open-coordinator

- **open-coordinator** (`/workspace/@alkimiadev/open-coordinator`): worktree orchestration, session spawning, anomaly detection
- **open-memory**: session introspection, context awareness, history browsing
- Both use SSE events but for different purposes
- Both implement `experimental.session.compacting` — open-memory's version is more detailed
- Can be used together or independently

## Recommended AGENTS.md Additions for Consumers

When using this plugin in an OpenCode project, consider adding these lines to your project's `AGENTS.md` so that agents know about and can effectively use the memory tools:

```markdown
## Memory Tools (via @alkdev/open-memory plugin)

You have access to two tools for managing your context and accessing session history:

### memory({tool: "...", args: {...}})

Read-only tool for introspecting your session history and context state. Available operations:
- `memory({tool: "help"})` — full reference with examples
- `memory({tool: "summary"})` — quick counts of projects, sessions, messages, todos
- `memory({tool: "sessions"})` — list recent sessions (useful for finding past work)
- `memory({tool: "messages", args: {sessionId: "..."}})` — read a session's conversation
- `memory({tool: "search", args: {query: "..."}})` — search across all conversations
- `memory({tool: "compactions", args: {sessionId: "..."}})` — view compaction checkpoints
- `memory({tool: "context"})` — check your current context window usage

### memory_compact()

Trigger compaction on the current session. This summarizes the conversation so far to free context space.

**When to use memory_compact:**
- When context is above 80% (check with `memory({tool: "context"})`)
- When you notice you're losing track of earlier conversation details
- At natural breakpoints in multi-step tasks (after completing a subtask, before starting a new one)
- When the system prompt shows a yellow/red/critical context warning
- Proactively, rather than waiting for automatic compaction at 92%

**When NOT to use memory_compact:**
- When context is below 50% (it wastes a compaction cycle)
- In the middle of a complex edit that you need immediate context for
- When the task is nearly complete (just finish the task instead)

Compaction preserves your most important context in a structured summary — you will continue the session with the summary as your starting point.
```

## Roadmap

### Future improvements
- FTS5 virtual table support for better search (stemming, ranking)
- Configurable thresholds via plugin config
- Session comparison tools
- Export/import helpers
- Integration tests

## References

- OpenCode source: `/workspace/opencode` — `packages/opencode/src/session/compaction.ts`, `overflow.ts`
- OpenCode plugin SDK: `/workspace/opencode/packages/plugin/src/index.ts`
- Plugin types: see `Hooks` interface for all available hooks
- Bun SQLite docs: https://bun.com/docs/runtime/sqlite
- OpenCode DB schema: `message`, `part`, `session`, `project`, `todo` tables