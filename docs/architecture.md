# Open Memory: Architecture & Research

> **Note**: `AGENTS.md` is the canonical operational reference for this project. This document provides deeper context on the research and design decisions.

## Overview

`@alkdev/open-memory` is a standalone OpenCode plugin providing three capabilities:

1. **Context Awareness** — real-time tracking of context window usage with proactive warnings
2. **Session History Browser** — structured access to past sessions, messages, plans, and search
3. **Compaction Management** — better compaction prompts and on-demand compaction triggering

The core problem: OpenCode's automatic compaction fires at ~92% context usage with no warning. The default prompt frames it as "summarize for another agent" when it's the same agent continuing. This is disorienting and derailing. Open-memory gives agents awareness, control, and better summaries.

## Problem Statement

### Automatic Compaction is Disorienting
- Fires at ~92% with no advance warning
- Default prompt says "summarize for another agent" — misleading
- Agent loses context at an unpredictable point
- No way to compact at a natural breakpoint

### No History Access Within Sessions
- Agents can't reference prior sessions, decisions, or work
- The `opencode-memory.md` skill shows queries are possible via `sqlite3` but require manual bash commands
- No structured tool interface for browsing history

### Context Window Opacity
- The agent has no idea how close it is to compaction
- No visibility into token usage trends within a session

## Architecture

### Tool Design: Router Pattern

The plugin exposes exactly 2 tools to the agent:

| Tool | Type | Purpose |
|------|------|---------|
| `memory` | Read-only router | Dispatches to 8 internal operations by `{tool: "name", args: {...}}` |
| `memory_compact` | Mutation | Triggers compaction via `ctx.client.session.summarize()` |

**Why a router?** OpenCode has ~13.5k token baseline context bloat with just "hello world". Each tool definition adds its JSON schema to the system prompt. 8 separate tools = 8 schemas consuming context. By collapsing into a router, the agent sees only 2 tool definitions instead of 8, dramatically reducing context overhead.

This pattern is inspired by toolEnv's `/call` registry approach and is applicable to other plugins that expose many operations.

### Three Pillars

#### 1. Context Awareness

**SSE-based token tracking:**

- Subscribe to `message.updated` events via the `event` plugin hook
- Track `tokens.input` from assistant messages per session
- The `tokens.input` on the latest assistant message = current context size
- Compare against model's `limit.context` to compute percentage used
- Model limits available from `ctx.client.config.get()`

**Thresholds** (defined in `src/context/thresholds.ts` as the single source of truth):
- **Green** (<70%): Healthy, no action needed
- **Yellow** (70-85%): Consider compacting at next break point
- **Red** (85-92%): Strongly recommend compacting now
- **Critical** (>92%): Imminent automatic compaction

**Proactive notification:**
- `experimental.chat.system.transform` hook injects context percentage into system prompt
- Agent always knows its context status without calling a tool
- At yellow/red thresholds, injects an explicit advisory note

#### 2. Compaction Management

**`memory_compact` tool:**
- Calls `ctx.client.session.summarize()` to trigger compaction on the current session
- Requires `providerID` and `modelID` — obtained from the session's last user message or context tracker
- **Must NOT await `summarize()`** — returns immediately, schedules via `setTimeout(0)` because compaction can't start until the tool returns control to the event loop
- Refuses to compact if context is below 50% (wastes a compaction cycle)
- This gives the agent explicit control over *when* compaction happens

**`experimental.session.compacting` hook:**
- Replaces the default "summarize for another agent" prompt
- Better prompt emphasizes self-continuity, preserving task context, decisions, and next steps
- Uses structured template: Goal, Instructions, Discoveries, Accomplished, Relevant files, Notes

#### 3. Session History Browser

All backed by read-only `bun:sqlite` queries to `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db`.

**Operations** (all accessed via the `memory` router):

| Operation | Purpose | Key args |
|-----------|---------|----------|
| help | Show available operations | tool (optional, for details on one) |
| summary | Quick counts: projects, sessions, messages, todos | — |
| sessions | List recent sessions with metadata | limit, projectPath |
| messages | Read messages from a session as markdown | sessionId, limit |
| search | Text search across all conversations (LIKE-based) | query, limit |
| compactions | List/read compaction checkpoints for a session | sessionId, read (1-based index) |
| context | Current context window usage | — |
| plans | List and read saved plans | read (filename) |

**Rendering:**
- Markdown tables for session lists
- Formatted conversation transcripts for `messages`
- Snippet + session reference for search results
- Compaction checkpoints as navigable indices with summary previews
- All queries use `LIMIT` and parameterized `db.prepare().all(params)`

### Compaction Data in DB

When compaction occurs, OpenCode creates:
1. A synthetic `user` message with a `compaction`-type part (`part.data = {type: "compaction", auto: true/false, overflow: true/false}`)
2. `message.data.summary = {diffs: [...]}` on the compaction message
3. The assistant message immediately after contains the actual summary text in a `text`-type part

The `compactions` operation queries for `compaction`-type parts and retrieves the adjacent summary text, presenting them as navigable checkpoints. This is a stepping stone toward agents having their own UI with HUD + last N messages + tools for long-term memories.

## Component Design

```
src/
├── index.ts              # Plugin entry: hooks + tool registration
├── tools.ts              # 2 tools: memory router + memory_compact (with setTimeout fix)
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

## Key Technical Details

### Context Percentage Calculation

From `overflow.ts` in OpenCode source:
```typescript
count = tokens.total || (input + output + cache.read + cache.write)
reserved = config.compaction?.reserved ?? min(20000, maxOutputTokens)
usable = model.limit.input ? model.limit.input - reserved
                        : model.limit.context - maxOutputTokens
```

The `tokens.input` field on the last assistant message represents the context size at the time that message was sent. We track this and compare it against the model's context limit (from config/providers), falling back to 200k.

### Session Summarize API

The SDK exposes `ctx.client.session.summarize()`:
```typescript
ctx.client.session.summarize({
  path: { id: sessionID },
  body: { providerID, modelID },
})
```

This triggers the compaction flow in OpenCode's server. **Must not be awaited** — see the `memory_compact` deadlock note above.

### Plugin Hooks

**`experimental.session.compacting`:**
```typescript
async (input, output) => {
  output.prompt = getCompactionPrompt(); // replaces default entirely
}
```

**`experimental.chat.system.transform`:**
```typescript
async (input, output) => {
  const info = contextTracker.getContextInfo(input.sessionID);
  if (info) {
    output.system.push(`🟢 Context: ${info.percentage}% used (...)`);
  }
}
```

**`event`:**
```typescript
async ({ event }) => {
  contextTracker.handleEvent(event);
}
```

## Relationship to `open-coordinator`

- **Open-coordinator** handles worktree orchestration, session spawning, bidirectional communication
- **Open-memory** handles session introspection, context awareness, history browsing
- Both use SSE event streams but for different purposes
- Both can be used together — coordinator for multi-session workflows, memory for context management
- Both implement `experimental.session.compacting` — open-memory's version is more detailed
- The router pattern (2 tools instead of many) was first applied here and can be applied to open-coordinator

## Future Work

- FTS5 virtual table support for better search (stemming, ranking)
- Configurable thresholds via plugin config
- Session comparison tools
- Export/import helpers
- Integration tests

## References

- OpenCode source: `/workspace/opencode` — especially `packages/opencode/src/session/compaction.ts`, `overflow.ts`
- OpenCode plugin SDK: `/workspace/opencode/packages/plugin/src/index.ts`
- OpenCode plugin types: see `Hooks` interface for all available hooks
- Open-coordinator plugin: `/workspace/@alkimiadev/open-coordinator` — architecture pattern reference
- OpenCode DB schema: `message`, `part`, `session`, `project`, `todo` tables
- OpenCode config schema: `compaction.auto`, `compaction.prune`, `compaction.reserved` fields
- Bun SQLite docs: https://bun.com/docs/runtime/sqlite