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

### Three Pillars

#### 1. Context Awareness

**SSE-based token tracking** (same pattern as `open-coordinator`'s detection system):

- Subscribe to `ctx.client.global.event()` SSE stream
- Track `tokens.input` from `message.updated` events per session
- The `tokens.input` on the latest assistant message = current context size
- Compare against model's `limit.context` to compute percentage used
- Model limits available from `ctx.client.config.get()` or provider info

**Thresholds:**
- **Green** (<70%): Healthy, no action needed
- **Yellow** (70-85%): Consider compacting at next break point
- **Red** (85-92%): Strongly recommend compacting now
- **Critical** (>92%): Imminent automatic compaction

**Proactive notification:**
- Use `experimental.chat.system.transform` hook to inject context percentage into system prompt
- Agent always knows its context status without calling a tool
- At yellow/red thresholds, inject an explicit advisory note

**Tool: `memory_context`**
- Returns current token usage, model context limit, percentage, and status
- Includes trend (growing fast vs. stable)
- Lists model info

#### 2. Compaction Management

**`memory_compact` tool:**
- Calls `ctx.client.session.summarize()` to trigger compaction on the current session
- Requires `providerID` and `modelID` — obtained from the session's last user message or config
- This gives the agent explicit control over *when* compaction happens

**`experimental.session.compacting` hook:**
- Replaces the default "summarize for another agent" prompt
- Better prompt emphasizes self-continuity, preserving task context, decisions, and next steps

**Default instructions in system prompt:**
- "When context exceeds 85%, use `memory_compact` at your next natural break point"
- "At 90%+, compact immediately if possible"

#### 3. Session History Browser

All backed by read-only `bun:sqlite` queries to `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db`.

**Tools:**

| Tool | Purpose |
|------|---------|
| `memory_summary` | Quick counts: projects, sessions, messages, todos |
| `memory_sessions` | List recent sessions with metadata, sorted by update time |
| `memory_messages` | Read messages from a specific session as markdown |
| `memory_search` | Full-text search across all conversations (LIKE-based) |
| `memory_plans` | List and read saved plans |

**Rendering:**
- Markdown tables for session lists
- Formatted conversation transcripts for `memory_messages`
- Snippet + session reference for search results
- All queries use `LIMIT` and parameterized `db.prepare().all(params)`

## Component Design

```
src/
├── index.ts              # Plugin entry: hooks + tool registration
├── tools.ts              # Tool definitions (memory_*)
├── context/
│   ├── tracker.ts        # SSE token tracking (per-session)
│   ├── thresholds.ts     # Context percentage thresholds & status
│   └── notify.ts         # System prompt injection for warnings
├── history/
│   ├── queries.ts        # bun:sqlite read-only query helper
│   ├── format.ts         # Markdown rendering utilities
│   └── search.ts         # Full-text search logic
└── compaction/
    └── prompt.ts         # Better compaction prompt template
```

## Key Technical Details

### Context Percentage Calculation

From `overflow.ts` in OpenCode source:
```typescript
// The actual check is:
// count >= usable
// where:
//   count = tokens.total || (input + output + cache.read + cache.write)
//   reserved = config.compaction?.reserved ?? min(20000, maxOutputTokens)
//   usable = model.limit.input ? model.limit.input - reserved
//                           : model.limit.context - maxOutputTokens
```

The `tokens.input` field on the last assistant message represents the context size at the time that message was sent. We track this and compare it against the model's context limit (from config/providers).

### Session Summarize API

The SDK exposes `ctx.client.session.summarize()`:
```typescript
ctx.client.session.summarize({
  path: { id: sessionID },
  body: { providerID, modelID },
})
```

This triggers the compaction flow in OpenCode's server.

### Plugin Hook: `experimental.session.compacting`

```typescript
"experimental.session.compacting": async (input, output) => {
  // output.context: string[] — appended to default prompt
  // output.prompt?: string — replaces default prompt entirely
  output.prompt = `You are compacting your own session...`;
}
```

### Plugin Hook: `experimental.chat.system.transform`

```typescript
"experimental.chat.system.transform": async (input, output) => {
  // Can append strings to the system prompt
  const contextInfo = getContextInfo(input.sessionID);
  if (contextInfo) {
    output.system.push(`Context: ${contextInfo.percentage}% used (${contextInfo.status})`);
  }
}
```

## Relationship to `open-coordinator`

- **Open-coordinator** handles worktree orchestration, session spawning, bidirectional communication
- **Open-memory** handles session introspection, context awareness, history browsing
- Both use SSE event streams but for different purposes
- Both can be used together — coordinator for multi-session workflows, memory for context management
- The `experimental.session.compacting` hook in coordinator has a good prompt already; open-memory will provide an enhanced version that includes task context awareness

## References

- OpenCode source: `/workspace/opencode` — especially `packages/opencode/src/session/compaction.ts`, `overflow.ts`, `status.ts`
- OpenCode plugin SDK: `/workspace/opencode/packages/plugin/src/index.ts`
- OpenCode plugin types: see `Hooks` interface for all available hooks
- Open-code coordinator plugin: `/workspace/@alkimiadev/open-coordinator` — architecture pattern reference
- Original memory browsing skill: `docs/research/opencode-memory/opencode-memory.md`
- OpenCode DB schema: `message`, `part`, `session`, `project`, `todo` tables
- OpenCode config schema: `compaction.auto`, `compaction.prune`, `compaction.reserved` fields

## Implementation Phases

### Phase 1: Foundation (current)
- Plugin scaffolding, build setup, basic hooks
- `experimental.session.compacting` hook with better default prompt
- Basic `memory_context` tool (context percentage calculation)

### Phase 2: History Browser
- `memory_summary`, `memory_sessions`, `memory_messages`
- `memory_search` with full-text search
- `memory_plans` for plan access
- Markdown formatting for all outputs

### Phase 3: Context Awareness
- SSE-based token tracker
- Proactive context warnings via `experimental.chat.system.transform`
- `memory_compact` tool calling `session.summarize`
- Default system instructions on when to compact

### Phase 4: Polish
- Configurable thresholds
- Session comparison tools
- Export/import helpers
- Integration tests