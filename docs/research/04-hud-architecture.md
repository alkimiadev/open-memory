# HUD/AUI Architecture: Persistent State Injection via System Prompts

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [State Management](#3-state-management)
4. [Gradual Disclosure](#4-gradual-disclosure)
5. [System Prompt Injection Mechanism](#5-system-prompt-injection-mechanism)
6. [HUD Data Sources](#6-hud-data-sources)
7. [HUD Update Tools](#7-hud-update-tools)
8. [Relationship to Existing open-memory Tools](#8-relationship-to-existing-open-memory-tools)
9. [Implementation Plan](#9-implementation-plan)
10. [Risks and Open Questions](#10-risks-and-open-questions)
11. [Key File Reference](#key-file-reference)

---

## 1. Executive Summary

This document proposes an **Agent User Interface (HUD/AUI)** system for `@alkdev/open-memory` that injects structured, persistent state into the system prompt on every LLM call. The HUD gives the agent continuous awareness of its context, task state, and session history without requiring tool calls to check status. It supplements -- and in some scenarios replaces -- compaction as the primary context management mechanism.

**Core mechanism**: The `experimental.chat.system.transform` plugin hook is called before every LLM call. The plugin reconstructs the HUD from its current state and pushes it onto the `system` array. This is the same hook already used for context percentage injection; the HUD extends it into a richer, multi-section document.

**Key insight**: The HUD does **not** need to persist in the database or in messages. It is an ephemeral system prompt injection reconstructed from live state on every call. This means:
- It automatically survives compaction (injected fresh after each compaction cycle)
- It is always current (rebuilt on every LLM call)
- It does not consume context beyond the current call's injection
- It does not interfere with conversation history

---

## 2. Problem Statement

### 2.1 What Compaction Gets Wrong

Current compaction is a lossy, all-or-nothing mechanism:

1. **Information is discarded**: When compaction fires, the full conversation is replaced with an LLM-generated summary. Nuance, code snippets, exact error messages, and decision rationale are lost.

2. **Timing is suboptimal**: Compaction fires at ~92% (automatic) or when the agent calls `memory_compact`. Either way, the agent loses the ability to refer back to earlier conversation content.

3. **No continuous awareness**: Between compaction events, the agent has no structured view of its own state -- it relies on reading back through the conversation to re-orient.

4. **The "blasted with history" problem**: After compaction, the agent receives the entire summary at once. The agent has no way to selectively expand sections of interest without calling `memory` tool operations that consume additional context.

### 2.2 What a HUD Provides

A HUD solves these problems by providing:

1. **Continuous, structured state**: The agent always sees its current status (context %, active task, recent files) at the top of every system prompt.

2. **Gradual disclosure**: Sections can be collapsed or expanded based on context usage, budget, or agent intent. The agent sees summaries by default and uses tools to drill deeper.

3. **Complements compaction**: The HUD doesn't replace compaction for long conversations, but it reduces the need for it by keeping critical information in a small, always-present token budget.

4. **Agent-maintained state**: The agent can update HUD sections (notes, task status, key decisions) via tools, giving it a structured memory that persists across tool calls and survives compaction.

---

## 3. State Management

### 3.1 Where HUD State Lives

The HUD has two categories of state:

| Category | Examples | Storage | Lifetime |
|----------|----------|---------|----------|
| **Derived** (auto-computed) | Context %, session count, model name | In-memory (from `ContextTracker`) | Within session |
| **Agent-maintained** (mutable) | Task notes, key decisions, file list | File system (JSON) | Across sessions |

**Derived state** uses the same pattern as the existing `ContextTracker`: event-driven updates via the `event` hook, stored in a `Map<string, SessionData>`. This state is ephemeral -- it resets on plugin reload.

**Agent-maintained state** is the new capability. It needs to survive across:
- Tool calls within a session (it must be immediately available after update)
- Compaction (the system prompt injection ensures visibility after compaction)
- Plugin restarts (persisted to disk)
- Potentially, across sessions (same project)

### 3.2 File System Storage

For agent-maintained state, we propose a JSON file per session:

```
${XDG_DATA_HOME:-$HOME/.local/share}/opencode/hud/
├── sessions/
│   └── ses_abc123.json          # Per-session HUD state
└── project/
    └── <project-hash>.json      # Project-level HUD defaults
```

**Per-session file** (`sessions/{sessionId}.json`):

```typescript
interface HudState {
  // Metadata
  sessionId: string
  projectPath: string
  lastUpdated: number

  // Sections the agent can edit
  currentTask: string | null      // What am I working on?
  keyDecisions: string[]          // Important decisions made
  activeFiles: string[]           // Files currently being worked on
  notes: string[]                 // Freeform notes
  blockers: string[]               // Things preventing progress
  nextSteps: string[]             // Planned next actions

  // Sections auto-maintained by the plugin
  compactedContext: string | null  // Summary from last compaction (if any)
}
```

**Why JSON, not Markdown?**
- JSON is machine-readable and writable; no parsing ambiguity
- The HUD rendering is done by TypeScript code that produces Markdown for the prompt
- The `memory` tool's existing output is Markdown, but its inputs are structured (args)
- Tool updates are atomic key-value operations, not freeform text editing

**Why per-session files?**
- Sessions are the natural scope: each conversation has its own context
- OpenCode's DB uses session-scoped data (todos, messages, compaction summaries)
- Per-session files are simple to implement and reason about
- A project-level file provides defaults that new sessions inherit

### 3.3 Survival Across Tool Calls

Within a session, HUD state changes must be immediately visible. The flow is:

```
Agent calls hud_update({section: "currentTask", value: "Implementing auth middleware"})
  → Tool handler updates in-memory state + writes to file
  → Next LLM call triggers system.transform hook
  → Hook reads in-memory state (or file if cold start)
  → HUD section shows "Current Task: Implementing auth middleware"
```

The in-memory state is a `Map<string, HudState>` keyed by session ID. On update, we:
1. Update the in-memory map (immediate availability)
2. Write to disk asynchronously (durability)

On the next `system.transform` call, the hook reads from the in-memory map. If the session isn't in memory (cold start after plugin reload), it reads from disk.

### 3.4 Survival Across Compaction

The HUD **automatically survives compaction** because:

1. The `system.transform` hook is called on every LLM call, including after compaction
2. The HUD is reconstructed from in-memory state + file, not from conversation messages
3. Compaction removes old messages but does not touch plugin state or files

However, **compaction summaries** are particularly valuable for the HUD. When a compaction occurs:
- The `session.compacted` event fires
- We can query the compaction summary from the DB and store it in `compactedContext` in the HUD state
- This summary then appears in the HUD on every subsequent call, preserving the key information from before compaction

### 3.5 Survival Across Sessions

For cross-session continuity, we use a project-level defaults file:

```typescript
interface ProjectHudDefaults {
  projectPath: string
  projectNotes: string[]       // Persistent project-level notes
  keyFiles: string[]           // Important project files to always show
  conventions: string[]        // Project conventions to remember
  lastUpdated: number
}
```

When a new session starts, the HUD can show project-level defaults as a starting state. The agent then updates the session-scoped HUD as work proceeds.

**Concurrent sessions**: Each session has its own HUD state file. Concurrent sessions work naturally because they don't share mutable state. The `system.transform` hook receives `sessionID`, so it loads the correct state for each session.

### 3.6 In-Memory Architecture

```typescript
class HudManager {
  private sessions = new Map<string, HudState>()
  private ctx: PluginInput
  private hudDir: string

  constructor(ctx: PluginInput) {
    this.ctx = ctx
    this.hudDir = `${process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`}/opencode/hud`
  }

  // Get HUD state for a session (in-memory, with file fallback)
  getState(sessionId: string): HudState {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!
    }
    // Cold start: load from file
    const state = this.loadFromDisk(sessionId)
    this.sessions.set(sessionId, state)
    return state
  }

  // Update a section of the HUD
  updateSection(sessionId: string, section: keyof HudState, value: unknown): HudState {
    const state = this.getState(sessionId)
    // Type-safe update
    ;(state as any)[section] = value
    state.lastUpdated = Date.now()
    // Async persist
    this.persistToDisk(sessionId, state).catch(() => {})
    return state
  }

  // Append-based updates for array sections
  appendToSection(sessionId: string, section: "keyDecisions" | "notes" | "activeFiles" | "blockers" | "nextSteps", item: string): HudState {
    const state = this.getState(sessionId)
    const arr = state[section] as string[]
    if (!arr.includes(item)) {
      arr.push(item)
      state.lastUpdated = Date.now()
      this.persistToDisk(sessionId, state).catch(() => {})
    }
    return state
  }

  // Load from file
  private loadFromDisk(sessionId: string): HudState {
    try {
      const data = Bun.file(`${this.hudDir}/sessions/${sessionId}.json`).jsonSync()
      return data as HudState
    } catch {
      // New session: return defaults
      return {
        sessionId,
        projectPath: this.ctx.project?.path ?? "",
        lastUpdated: Date.now(),
        currentTask: null,
        keyDecisions: [],
        activeFiles: [],
        notes: [],
        blockers: [],
        nextSteps: [],
        compactedContext: null,
      }
    }
  }

  // Persist to file (async, fire-and-forget)
  private async persistToDisk(sessionId: string, state: HudState): Promise<void> {
    await Bun.write(
      `${this.hudDir}/sessions/${sessionId}.json`,
      JSON.stringify(state, null, 2),
    )
  }
}
```

This mirrors the existing `ContextTracker` pattern (in-memory map with event-driven updates) but adds file persistence.

---

## 4. Gradual Disclosure

### 4.1 The "Not Blasted with Entire History" Problem

The user's requirement: "how and if we could do this such that the agents aren't blasted with the entire history at once."

This is the core UX challenge. A naive HUD that dumps everything into the system prompt on every call would:
- Consume too many tokens (history summaries can be thousands of tokens)
- Provide diminishing returns (the agent can't act on all that information simultaneously)
- Compound across calls (the same 2000-token HUD is re-sent every turn)

### 4.2 Tiered Disclosure Strategy

The solution is a **tiered disclosure model** with three levels:

| Tier | Token Budget | When Shown | Content |
|------|-------------|------------|---------|
| **Status** | 150-300 tokens | Every call | Context %, model, task summary, alert flags |
| **Summary** | 300-600 tokens | When context < 70% (green) | Status + recent decisions, active files, notes previews |
| **Detail** | 600-1000 tokens | On explicit request only (via `memory` tool) | Full notes, decisions with rationale, expanded file list |

**Status tier** (always shown, ~150-300 tokens):

```
## State
🟢 Context: 45% used (90,000 / 200,000 tokens, anthropic/claude-sonnet-4-20250514)
Task: Implementing auth middleware
Files: 3 active | Decisions: 2 | Notes: 4 | Blockers: 0
```

**Summary tier** (shown when context is green, ~400-600 tokens):

```
## State
🟢 Context: 45% used (90,000 / 200,000 tokens, anthropic/claude-sonnet-4-20250514)

### Current Task
Implementing auth middleware -- JWT validation + refresh token rotation

### Key Decisions
- Using RS256 for JWT signing (not HS256) for key rotation support
- Refresh tokens stored hashed in DB, not plaintext

### Active Files
- src/middleware/auth.ts (editing)
- src/routes/login.ts (editing)
- src/config/auth.ts (referencing)

### Notes (showing first 2 of 4, use `memory({tool: "hud_notes"})` for all)
- Refresh token TTL: 7 days
- Rate limit: 5 requests/min for login endpoint

### Next Steps
1. Complete JWT validation logic
2. Add refresh token rotation endpoint
3. Write integration tests
```

**Detail tier** (only via `memory` tool, on-demand):

The agent calls `memory({tool: "hud_notes"})` or `memory({tool: "hud_decisions"})` to get the full content. This costs a tool call but does not inject into the system prompt.

### 4.3 Context-Adaptive Rendering

The HUD should **adapt its detail level based on context usage**:

```typescript
function renderHud(state: HudState, contextInfo: ContextInfo | null): string {
  const percentage = contextInfo?.percentage ?? 0

  // Always show status line
  const lines: string[] = ["## State"]
  lines.push(renderContextLine(contextInfo))

  if (state.currentTask) {
    lines.push(`**Task**: ${state.currentTask}`)
  }

  // Summary counts (always shown -- very cheap)
  const counts = [
    state.keyDecisions.length && `Decisions: ${state.keyDecisions.length}`,
    state.activeFiles.length && `Files: ${state.activeFiles.length}`,
    state.notes.length && `Notes: ${state.notes.length}`,
    state.blockers.length && `Blockers: ${state.blockers.length}`,
  ].filter(Boolean)
  if (counts.length) lines.push(counts.join(" | "))

  // Below green threshold: show full summaries
  if (percentage < THRESHOLDS.yellow) {
    lines.push(renderFullSummary(state))
  }

  // Yellow threshold: show abbreviated summaries
  if (percentage >= THRESHOLDS.yellow && percentage < THRESHOLDS.red) {
    lines.push(renderAbbreviatedSummary(state))
  }

  // Red/critical: status line only, with compact advisory
  if (percentage >= THRESHOLDS.red) {
    lines.push("⚠ Use memory({tool: 'hud_notes'}) to view detailed state.")
  }

  // Always show blockers (critical info regardless of context level)
  if (state.blockers.length > 0) {
    lines.push("### ⚠ Blockers")
    for (const b of state.blockers) lines.push(`- ${b}`)
  }

  // Always show compacted context if present (essential after compaction)
  if (state.compactedContext) {
    lines.push("### Compacted Context")
    lines.push(state.compactedContext)
  }

  return lines.join("\n")
}
```

### 4.4 Token Budget Accounting

We need to be disciplined about token costs. Approximate token costs:

| Section | Detail Level | Approx. Tokens | When Shown |
|---------|-------------|---------------|------------|
| Context status line | Minimal | ~30 | Always |
| Task line | Minimal | ~20 | Always |
| Summary counts | Minimal | ~25 | Always |
| Key decisions (summaries) | Abbreviated | ~80 | Green/Yellow |
| Key decisions (full) | Full | ~200 | Green only |
| Active files | Abbreviated | ~50 | Green/Yellow |
| Notes preview | Abbreviated | ~100 | Green only |
| Blockers | Full | ~50 | Always (if any) |
| Compacted context | Full | ~100-300 | Always (if present) |

**Total worst case (green, all sections)**: ~700-1000 tokens
**Total typical (yellow)**: ~300-500 tokens
**Total minimal (red/critical)**: ~100-200 tokens

Compared to the existing context injection (~50 tokens for just the status line), this is a meaningful increase. But compared to a compaction summary (typically 2000-5000 tokens), it's 5-20x more efficient for preserving the most critical state.

### 4.5 Prompt Caching Considerations

OpenCode uses a 2-part system prompt structure for caching (analyzed in the compaction research doc):

1. **Block 1**: Provider prompt (static across calls within a session)
2. **Block 2**: Everything else (agent instructions, context, HUD)

Since the HUD content changes on every call (context % updates, task changes), it's part of Block 2. This means the HUD breaks prompt caching for Block 2 on every call.

**Mitigation strategies**:

1. **Minimize per-call changes**: Only update the HUD content that actually changed since the last call. If nothing changed, the HUD string is identical and can benefit from caching.

2. **Separate static and dynamic sections**: The task description, decisions, and notes change infrequently. Only the context percentage changes on every call. We could push the static sections as one string and the dynamic context line as another string, allowing the static part to be cached.

```typescript
// Instead of one push:
output.system.push(renderHud(state, contextInfo))

// Consider two pushes:
output.system.push(renderHudStatic(state))   // cached across calls
output.system.push(renderHudDynamic(contextInfo)) // changes every call
```

However, this optimization is only meaningful if OpenCode's caching implementation respects multiple `system` array entries. From the research (see section 5), OpenCode already recombines system messages for caching. The key insight: pushing 2 strings allows OpenCode to potentially cache the first while the second changes.

In practice, the HUD is small enough (~300-700 tokens) that the caching impact is acceptable. Models with prompt caching (Claude 3.5+, GPT-4o) cache at the prefix level, so only the changed part re-enters.

---

## 5. System Prompt Injection Mechanism

### 5.1 How `experimental.chat.system.transform` Works

The hook is defined in the plugin SDK (`/workspace/opencode/packages/plugin/src/index.ts:251-256`):

```typescript
"experimental.chat.system.transform"?: (
  input: { sessionID?: string; model: Model },
  output: {
    system: string[]
  },
) => Promise<void>
```

**Invocation sites**:

1. **Primary** (`/workspace/opencode/packages/opencode/src/session/llm.ts:116-126`):
   ```typescript
   const header = system[0]
   await Plugin.trigger(
     "experimental.chat.system.transform",
     { sessionID: input.sessionID, model: input.model },
     { system },
   )
   // rejoin to maintain 2-part structure for caching if header unchanged
   if (system.length > 2 && system[0] === header) {
     const rest = system.slice(1)
     system.length = 0
     system.push(header, rest.join("\n"))
   }
   ```
   Called on every `LLM.stream()` invocation -- every assistant turn in the session loop.

2. **Agent generation** (`/workspace/opencode/packages/opencode/src/agent/agent.ts:340`):
   Called during the one-time agent generation call. No `sessionID` is passed here.

**Key behaviors**:

- The `output.system` array is **mutable** -- plugins can `push()` new strings or modify existing ones
- Multiple plugins modify the same `system` array in registration order
- After all plugins run, OpenCode optimizes the array for caching: if the first element (provider prompt) is unchanged and there are >2 elements, it recombines the extras into a single second element
- **The hook is called on every LLM call**, not just session start
- **The hook is async** -- it can perform I/O operations (DB queries, file reads)
- **sessionID is optional** -- it's absent during agent generation. Plugins must handle this.

### 5.2 System Prompt Assembly Order

From the LLM source code and prior research, the full system prompt is assembled in this order:

1. **Agent prompt** (from `.opencode/agents/*.md`) or provider default prompt
2. **Custom system** (from plugin hooks, compaction, plan mode injection)
3. **User-provided system prompt** (from the user message)
4. **Plugin modifications** via `experimental.chat.system.transform`
5. **Environment info** (model name, working directory, platform, date)
6. **Skills list** (available skills/tools)
7. **Instruction files** (AGENTS.md, CLAUDE.md)

After all plugins run:
8. **Caching optimization**: recombine system messages into 2 blocks if first element is unchanged

The HUD injection happens at step 4. It appears **after** the agent/system prompt but **before** environment info and instruction files. This is a good position: it's visible to the agent but doesn't interfere with higher-priority instructions.

### 5.3 What the Agent Sees

Example system prompt structure with HUD injection:

```
[System Message 1: Agent prompt + custom system]
"You are Claude, an AI assistant..."

[System Message 2: Plugin injections + environment + skills + instructions]
"🟢 Context: 45% used (90,000/200,000 tokens)
## State
...
Here are the available tools...
Current date: 2026-04-22
Instructions from: AGENTS.md..."
```

After OpenCode's caching optimization, the HUD is merged into the second system message block. This is efficient for caching -- the first block (agent prompt) rarely changes and benefits from caching.

### 5.4 Current open-memory Implementation

The existing injection in `/workspace/@alkdev/open-memory/src/index.ts:16-49`:

```typescript
"experimental.chat.system.transform": async (input, output) => {
  if (!input.sessionID) return;

  const info = contextTracker.getContextInfo(input.sessionID);
  if (!info) return;

  const statusEmoji = /* ... */;
  const advisory = /* ... */;
  const lines = [
    `${statusEmoji} Context: ${info.percentage}% used (...)`,
  ];
  if (advisory) lines.push(advisory);
  output.system.push(lines.join("\n"));
},
```

**This is ~50 tokens per call.** The HUD would extend this to ~300-700 tokens per call, depending on the tier.

### 5.5 Extending the Current Hook

The HUD extension is straightforward -- we extend the existing `system.transform` hook:

```typescript
"experimental.chat.system.transform": async (input, output) => {
  if (!input.sessionID) return;

  const sessionId = input.sessionID;
  const contextInfo = contextTracker.getContextInfo(sessionId);
  const hudState = hudManager.getState(sessionId);

  // Render HUD based on context level
  const hud = renderHud(hudState, contextInfo);
  output.system.push(hud);
},
```

The `renderHud` function handles tiered rendering as described in section 4.3.

---

## 6. HUD Data Sources

### 6.1 Event-Driven Data (Real-Time)

These data sources are updated via the `event` hook, mirroring the existing `ContextTracker` pattern:

| Data | Event Source | Tracking |
|------|-------------|----------|
| Context % / tokens | `message.updated` (assistant messages) | Already tracked in `ContextTracker` |
| Compaction occurrence | `session.compacted` event | New: trigger HUD summary update |
| File edits | `file.edited` event | New: track recently edited files |
| Todo status | `todo.updated` event | New: track task status |

**Available SSE events** (from OpenCode source):

| Event | Schema | Usable for HUD? |
|-------|--------|----------------|
| `message.updated` | `{ sessionID, info: Message }` | Yes -- context tracking (existing) |
| `message.part.updated` | `{ sessionID, part, time }` | Possible -- tool call tracking |
| `message.part.delta` | `{ sessionID, ... }` | No -- streaming delta, too frequent |
| `session.created` | `{ sessionID, info }` | Minimal value |
| `session.updated` | `{ sessionID, info }` | Yes -- title, status changes |
| `session.compacted` | `{ sessionID }` | Yes -- trigger summary update |
| `session.diff` | `{ sessionID, diff }` | Possible -- file change tracking |
| `file.edited` | `{ file }` | Yes -- track recently edited files |
| `todo.updated` | `{ sessionID, todos }` | Yes -- task status |

### 6.2 On-Demand Data (Queried at Render Time)

These are queried fresh from the database when the HUD is rendered:

| Data | Source | Query |
|------|--------|-------|
| Session title | `session` table | `SELECT title FROM session WHERE id = ?` |
| Compaction count | `message` + `part` tables | Count compaction parts for session |
| Session start time | `session` table | `SELECT time_created FROM session WHERE id = ?` |
| Project name | `project` table | Joined with session |

**Performance consideration**: These queries run on every `system.transform` call. Since `bun:sqlite` in readonly mode is sub-millisecond for indexed queries, 2-3 simple queries are acceptable. However, we should:
1. Cache query results in the in-memory state
2. Only re-query when a relevant event indicates a change (e.g., `session.updated` to refresh the title)
3. Never do expensive queries (no full-text search, no joins across large tables) in the system transform hook

### 6.3 Agent-Maintained Data (Via HUD Tools)

These are updated by the agent through tool calls:

| Data | Tool | Update Type |
|------|------|-------------|
| Current task | `memory({tool: "hud_update", args: {section: "currentTask", value: "..."}})` | Full replacement |
| Key decisions | `memory({tool: "hud_decision", args: {decision: "..."}})` | Append |
| Active files | `memory({tool: "hud_file", args: {file: "..."}})` | Append (with dedup) |
| Notes | `memory({tool: "hud_note", args: {note: "..."}})` | Append |
| Blockers | `memory({tool: "hud_blocker", args: {blocker: "..."}})` | Append |
| Next steps | `memory({tool: "hud_step", args: {step: "..."}})` | Append |

### 6.4 File Watching Alternative (Not Recommended)

One could also populate HUD data by watching the filesystem (`.opencode/hud/*.md` files). This was explored in the agent definitions pattern research (doc 02). However:
- The agent definitions pattern loads static Markdown files at session start
- HUD sections need **reactive** data that changes during a session
- File watching adds complexity (watcher, debouncing, file I/O on every change)
- Agent tool calls are simpler and more explicit

For Phase 1, we use tool calls for agent-maintained data and events for derived data. File-based HUD definitions (like `.opencode/hud/*.md`) can be added later if user configuration is desired.

---

## 7. HUD Update Tools

### 7.1 Proposed Tool Schema

We have two design options:

**Option A: New operations on the existing `memory` router**

Extend the `memory` tool's routing with new operations:

```
memory({tool: "hud_update", args: {section: "currentTask", value: "Implementing auth"}})
memory({tool: "hud_note", args: {note: "Refresh tokens have 7-day TTL"}})
memory({tool: "hud_decision", args: {decision: "Using RS256 for JWT signing"}})
memory({tool: "hud_clear", args: {section: "notes"}})
memory({tool: "hud", args: {}})   // read current HUD state
```

**Option B: Separate `hud` tool**

A dedicated `hud` tool that handles all HUD operations:

```
hud({action: "update", section: "currentTask", value: "Implementing auth"})
hud({action: "note", note: "Refresh tokens have 7-day TTL"})
hud({action: "decision", decision: "Using RS256 for JWT signing"})
hud({action: "clear", section: "notes"})
hud({action: "read"})   // read current HUD state
hud({action: "compact"})  // save current key info and trigger compaction
```

**Recommendation: Option A (extend `memory` router)**.

Rationale:
- The router pattern already exists and is well-understood
- Adding a third tool increases the agent's visible tool surface (the AGENTS.md must document each tool)
- The `memory` tool already handles similar CRUD-like operations (search, messages, context)
- The router pattern keeps the tool count at 2 (memory + memory_compact) or 3 (memory + memory_compact + hud_compact)
- Adding operations to the router only increases the help text, not the JSON schema that consumes context

### 7.2 Operations

| Operation | Purpose | Key Args | Update Type |
|-----------|---------|----------|-------------|
| `hud` | Read current HUD state | section (optional, for specific section) | Read-only |
| `hud_update` | Update a mutable section | section, value | Full replacement |
| `hud_note` | Add a note | note | Append |
| `hud_decision` | Record a key decision | decision | Append |
| `hud_file` | Track an active file | file, action ("add"/"remove") | Append/Remove |
| `hud_blocker` | Add/remove a blocker | blocker, action ("add"/"remove") | Append/Remove |
| `hud_step` | Add a next step | step | Append |
| `hud_clear` | Clear a section or reset all | section (optional, clears all if omitted) | Full clear |

### 7.3 Tool Descriptions (for Agent)

```python
memory({tool: "hud"}):
  """Read the current HUD state -- your persistent status display that appears in every system prompt.
  Shows current task, key decisions, active files, notes, blockers, and next steps.
  Call with no args for full state, or specify a section for just that part."""

memory({tool: "hud_update", args: {section: "currentTask", value: "..."}}):
  """Update a HUD section with a new value. Sections: currentTask, nextSteps, activeFiles, notes, keyDecisions, blockers.
  For array sections, this replaces the entire array. Use hud_note/hud_decision/hud_file for appending."""

memory({tool: "hud_note", args: {note: "..."}}):
  """Add a note to the HUD. Notes appear in your system prompt and survive compaction.
  Use for information you'll need later but might lose in conversation history."""

memory({tool: "hud_decision", args: {decision: "..."}}):
  """Record a key decision in the HUD. Decisions survive compaction and are always visible.
  Use when you make an important choice that you'll need to reference later."""

memory({tool: "hud_file", args: {file: "...", action: "add"}}):
  """Track a file in the HUD's active files list. Use 'add' when starting to edit a file, 'remove' when done."""

memory({tool: "hud_blocker", args: {blocker: "...", action: "add"}}):
  """Add or remove a blocker. Blockers are always shown in the HUD, even at critical context levels."""

memory({tool: "hud_step", args: {step: "..."}}):
  """Add a next step to the HUD. Steps survive compaction and help you maintain progress tracking."""

memory({tool: "hud_clear", args: {section: "notes"}}):
  """Clear a HUD section, or clear all sections if no section specified. Use when starting a new task."""
```

### 7.4 Update Semantics

**Full replacement** (`hud_update` for scalar sections):
- `currentTask`: The agent sets what it's currently working on. Only one task at a time.
- Setting `currentTask` to `null` or `""` clears it.

**Append** (for array sections):
- `hud_note`, `hud_decision`, `hud_step`: Append to the end of the array.
- Duplicates are silently ignored (simple string equality check).
- Array sections have a **maximum length** to prevent unbounded growth:
  - `keyDecisions`: max 10
  - `notes`: max 20
  - `activeFiles`: max 15
  - `blockers`: max 10
  - `nextSteps`: max 10
- When the maximum is reached, the oldest entry is removed (FIFO).

**Remove** (for array sections):
- `hud_file` with `action: "remove"`: Remove a specific file from active files.
- `hud_blocker` with `action: "remove"`: Remove a specific blocker.

**Clear** (`hud_clear`):
- Clears a specific section or all sections.
- Useful when starting a new task or after compaction to reset state.

### 7.5 Compaction Integration

When a compaction event is received, the HUD should:

1. **Capture the compaction summary** (query the DB for the latest compaction summary text)
2. **Store it in `compactedContext`** in the HUD state
3. **Clear or reset sections** that are now covered by the summary (e.g., if the summary includes "next steps", those can be removed from the HUD's next steps)

This happens in the `event` hook:

```typescript
event: async ({ event }) => {
  contextTracker.handleEvent(event);

  if (event.type === "session.compacted") {
    const sessionId = (event.properties as any)?.sessionID;
    if (sessionId) {
      // Load the latest compaction summary
      const summary = loadLatestCompactionSummary(sessionId);
      hudManager.updateSection(sessionId, "compactedContext", summary);
    }
  }
}
```

---

## 8. Relationship to Existing open-memory Tools

### 8.1 Memory Tool (Existing)

The existing `memory` tool is a router for read-only operations on the OpenCode database:

| Operation | Purpose |
|-----------|---------|
| summary | Quick counts |
| sessions | List sessions |
| messages | Read messages |
| message | Read single message |
| search | Text search |
| compactions | View compaction checkpoints |
| context | Current context usage |
| plans | Read plan files |
| help | Tool reference |

**The HUD complements -- not replaces -- these operations.**

- `memory({tool: "context"})` shows the same data as the HUD's context status line, but in a more detailed format. The HUD's context line is the summary; the tool provides details.
- `memory({tool: "search"})` and `memory({tool: "messages"})` remain the way to drill into specific history. The HUD shows **pointers** to history (e.g., "3 compaction checkpoints available"), not the full content.
- `memory({tool: "compactions"})` provides full compaction summaries. The HUD shows only that compaction occurred and provides a brief excerpt.

### 8.2 Memory_Compact Tool (Existing)

The existing `memory_compact` tool triggers compaction. The HUD does **not** replace this:

- `memory_compact` initiates compaction (a server-side action)
- The HUD **shows** when compaction has occurred and provides the summary
- After compaction, the HUD's `compactedContext` field is populated with the summary

The recommended workflow becomes:
1. Agent sees HUD showing yellow/red context status
2. Agent calls `memory_compact` at a natural breakpoint
3. Compaction fires, conversation history is summarized
4. HUD persists through compaction (injected fresh on next call)
5. The `compactedContext` section shows the summary

### 8.3 HUD vs. Compaction: Complementary Roles

| Aspect | Compaction | HUD |
|--------|-----------|-----|
| Purpose | Free context window space | Maintain persistent state |
| Mechanism | LLM summarizes conversation | Plugin injects structured state |
| When | Triggered at 92% or manually | Every LLM call |
| Content | LLM-generated narrative | Agent-maintained structured state |
| Token cost | 0 (after compaction, summary replaces history) | 300-700 tokens (on every call) |
| Survives compaction | Yes (it is compaction) | Yes (injected from file/state, not messages) |
| Information loss | Significant (narrative approximation) | None (exact key decisions, notes, files) |

The key insight: **the HUD reduces the need for compaction by keeping the most critical information in a small, always-visible token budget**. Instead of losing 200 messages and getting a 2000-token summary, the agent always has its key decisions, notes, and task state in 500 tokens.

### 8.4 Integration Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Plugin Entry (index.ts)                    │
│                                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────┐  │
│  │ ContextTracker  │  │   HudManager   │  │ event hook    │  │
│  │ (existing)      │  │   (new)         │  │ (extended)    │  │
│  │                 │  │                 │  │               │  │
│  │ - Track tokens │  │ - Session state │  │ - tokens      │  │
│  │ - Per-session   │  │ - File persist  │  │ - compaction  │  │
│  │   map           │  │ - Section CRUD  │  │ - file.edited │  │
│  └───────┬────────┘  └───────┬─────────┘  │ - todo.update │  │
│          │                   │              └───────┬───────┘  │
│          │                   │                      │          │
│          └───────────┬──────┘                      │          │
│                      │                             │          │
│  ┌───────────────────▼─────────────────────────────▼──────┐  │
│  │    system.transform hook                                 │  │
│  │                                                          │  │
│  │    1. Get context info from ContextTracker               │  │
│  │    2. Get HUD state from HudManager                     │  │
│  │    3. Render HUD with tiered disclosure                  │  │
│  │    4. output.system.push(hud)                            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │    Tool definitions (tools.ts)                            │ │
│  │                                                          │ │
│  │    memory router (existing):                              │ │
│  │    + hud, hud_update, hud_note, hud_decision,            │ │
│  │      hud_file, hud_blocker, hud_step, hud_clear           │ │
│  │                                                          │ │
│  │    memory_compact (existing, unchanged)                   │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## 9. Implementation Plan

### Phase 1: Core HUD with Static Sections (PR 1)

**Scope**: HUD that auto-generates from existing data sources, no agent-maintained sections yet.

Files to create/modify:

```
src/
├── hud/
│   ├── manager.ts         # HudManager class (in-memory + file state)
│   ├── renderer.ts         # renderHud() function with tiered disclosure
│   └── sections.ts         # Section rendering functions
├── index.ts                # Extend system.transform hook + event hook
└── tools.ts                # Add hud operations to memory router
```

**What works after Phase 1**:
- Context status line (existing, unchanged)
- Session metadata (title, session duration, compaction count) from DB
- Compacted context auto-populated on compaction events
- Tiered rendering based on context level
- `memory({tool: "hud"})` to read current HUD state

### Phase 2: Agent-Maintained Sections (PR 2)

**Scope**: Agent can write to HUD sections via tool calls.

Files to create/modify:

```
src/
├── hud/
│   ├── manager.ts         # Add update, append, clear methods
│   └── schema.ts          # HUD state schema with validation
└── tools.ts                # Add hud_update, hud_note, hud_decision, etc.
```

**What works after Phase 2**:
- `memory({tool: "hud_update"})`, `hud_note`, `hud_decision`, etc.
- Agent-maintained task state, decisions, notes
- File persistence of HUD state across plugin restarts

### Phase 3: Advanced Features (PR 3+)

- **Event-driven file tracking**: Auto-update `activeFiles` based on `file.edited` events
- **Todo integration**: Show todo status in HUD (from `todo.updated` events)
- **Project-level defaults**: Inherit HUD defaults from a project config file
- **Compaction integration**: Auto-capture compaction summary into `compactedContext`
- **Smart hints**: After compaction, suggest "use `memory({tool: 'hud_note'})` to preserve critical information before compacting again"

### 9.1 Renderer Implementation

```typescript
// src/hud/renderer.ts

import type { ContextInfo } from "../context/tracker.js";
import type { HudState } from "./manager.js";
import { THRESHOLDS } from "../context/thresholds.js";

const MAX_NOTES_PREVIEW = 3;
const MAX_DECISIONS_PREVIEW = 5;
const MAX_FILES_PREVIEW = 5;
const MAX_STEPS_PREVIEW = 3;

export function renderHud(state: HudState, contextInfo: ContextInfo | null): string {
  const percentage = contextInfo?.percentage ?? 0;
  const lines: string[] = [];

  // --- Status line (always shown) ---
  lines.push("## State");

  if (contextInfo) {
    const emoji = percentage >= THRESHOLDS.critical ? "🔴"
      : percentage >= THRESHOLDS.red ? "🟠"
      : percentage >= THRESHOLDS.yellow ? "🟡"
      : "🟢";
    lines.push(`${emoji} Context: ${percentage}% used (${contextInfo.usedTokens.toLocaleString()} / ${contextInfo.limitTokens.toLocaleString()} tokens, ${contextInfo.model})`);
  }

  if (state.currentTask) {
    lines.push(`**Task**: ${state.currentTask}`);
  }

  // Summary counts (always shown -- very cheap)
  const counts: string[] = [];
  if (state.keyDecisions.length) counts.push(`${state.keyDecisions.length} decision${state.keyDecisions.length !== 1 ? "s" : ""}`);
  if (state.activeFiles.length) counts.push(`${state.activeFiles.length} file${state.activeFiles.length !== 1 ? "s" : ""}`);
  if (state.notes.length) counts.push(`${state.notes.length} note${state.notes.length !== 1 ? "s" : ""}`);
  if (state.blockers.length) counts.push(`${state.blockers.length} blocker${state.blockers.length !== 1 ? "s" : ""}`);
  if (counts.length) lines.push(counts.join(" | "));

  // --- Blockers: always shown (critical regardless of context level) ---
  if (state.blockers.length > 0) {
    lines.push("### ⚠ Blockers");
    for (const b of state.blockers) lines.push(`- ${b}`);
  }

  // --- Detailed sections: shown based on context level ---

  if (percentage < THRESHOLDS.yellow) {
    // GREEN: full disclosure
    renderFullSections(state, lines);
  } else if (percentage < THRESHOLDS.red) {
    // YELLOW: abbreviated disclosure
    renderAbbreviatedSections(state, lines);
  } else {
    // RED/CRITICAL: minimal disclosure with hint
    lines.push("⚠ Context is limited. Use memory({tool: \"hud\"}) to view full state.");
  }

  // --- Compacted context: always shown if present ---
  if (state.compactedContext) {
    lines.push("### Previous Context");
    // Truncate if context is tight
    const maxLen = percentage >= THRESHOLDS.red ? 200 : 500;
    const ctx = state.compactedContext.length > maxLen
      ? state.compactedContext.slice(0, maxLen) + "..."
      : state.compactedContext;
    lines.push(ctx);
  }

  return lines.join("\n");
}

function renderFullSections(state: HudState, lines: string[]): void {
  if (state.keyDecisions.length > 0) {
    lines.push("### Key Decisions");
    for (const d of state.keyDecisions) lines.push(`- ${d}`);
  }
  if (state.activeFiles.length > 0) {
    lines.push("### Active Files");
    for (const f of state.activeFiles) lines.push(`- \`${f}\``);
  }
  if (state.notes.length > 0) {
    lines.push("### Notes");
    for (const n of state.notes) lines.push(`- ${n}`);
  }
  if (state.nextSteps.length > 0) {
    lines.push("### Next Steps");
    for (let i = 0; i < state.nextSteps.length; i++) {
      lines.push(`${i + 1}. ${state.nextSteps[i]}`);
    }
  }
}

function renderAbbreviatedSections(state: HudState, lines: string[]): void {
  if (state.keyDecisions.length > 0) {
    lines.push(`### Decisions (${state.keyDecisions.length})`);
    const shown = state.keyDecisions.slice(0, MAX_DECISIONS_PREVIEW);
    for (const d of shown) lines.push(`- ${d}`);
    if (state.keyDecisions.length > MAX_DECISIONS_PREVIEW) {
      lines.push(`  _...and ${state.keyDecisions.length - MAX_DECISIONS_PREVIEW} more. Use memory({tool: "hud"}) for all._`);
    }
  }
  if (state.activeFiles.length > 0) {
    lines.push(`### Files (${state.activeFiles.length})`);
    const shown = state.activeFiles.slice(0, MAX_FILES_PREVIEW);
    lines.push(shown.map(f => `\`${f}\``).join(", "));
  }
  if (state.notes.length > 0) {
    lines.push(`### Notes (${state.notes.length})`);
    const shown = state.notes.slice(0, MAX_NOTES_PREVIEW);
    for (const n of shown) lines.push(`- ${n}`);
    if (state.notes.length > MAX_NOTES_PREVIEW) {
      lines.push(`  _...and ${state.notes.length - MAX_NOTES_PREVIEW} more._`);
    }
  }
  if (state.nextSteps.length > 0) {
    lines.push("### Next Steps");
    const shown = state.nextSteps.slice(0, MAX_STEPS_PREVIEW);
    for (let i = 0; i < shown.length; i++) lines.push(`${i + 1}. ${shown[i]}`);
  }
}
```

### 9.2 Manager Implementation

```typescript
// src/hud/manager.ts

import type { PluginInput } from "@opencode-ai/plugin";
import { mkdirSync } from "node:fs";

export interface HudState {
  sessionId: string;
  projectPath: string;
  lastUpdated: number;
  currentTask: string | null;
  keyDecisions: string[];
  activeFiles: string[];
  notes: string[];
  blockers: string[];
  nextSteps: string[];
  compactedContext: string | null;
}

const SECTION_LIMITS: Record<string, number> = {
  keyDecisions: 10,
  activeFiles: 15,
  notes: 20,
  blockers: 10,
  nextSteps: 10,
};

export class HudManager {
  private sessions = new Map<string, HudState>();
  private ctx: PluginInput;
  private hudDir: string;

  constructor(ctx: PluginInput) {
    this.ctx = ctx;
    this.hudDir = `${process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`}/opencode/hud`;
    mkdirSync(`${this.hudDir}/sessions`, { recursive: true });
  }

  getState(sessionId: string): HudState {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }
    const state = this.loadFromDisk(sessionId);
    this.sessions.set(sessionId, state);
    return state;
  }

  updateSection(sessionId: string, section: keyof HudState, value: unknown): HudState {
    const state = this.getState(sessionId);
    if (section === "keyDecisions" || section === "activeFiles" || section === "notes" || section === "blockers" || section === "nextSteps") {
      const arr = value as string[];
      const limit = SECTION_LIMITS[section] ?? 20;
      (state as any)[section] = arr.slice(0, limit);
    } else {
      (state as any)[section] = value;
    }
    state.lastUpdated = Date.now();
    this.persistToDisk(sessionId, state);
    return state;
  }

  appendToSection(sessionId: string, section: "keyDecisions" | "activeFiles" | "notes" | "blockers" | "nextSteps", item: string): HudState {
    const state = this.getState(sessionId);
    const arr = state[section] as string[];
    if (!arr.includes(item)) {
      const limit = SECTION_LIMITS[section] ?? 20;
      if (arr.length >= limit) {
        arr.shift(); // FIFO: remove oldest
      }
      arr.push(item);
      state.lastUpdated = Date.now();
      this.persistToDisk(sessionId, state);
    }
    return state;
  }

  removeFromSection(sessionId: string, section: "activeFiles" | "blockers", item: string): HudState {
    const state = this.getState(sessionId);
    const arr = state[section] as string[];
    const idx = arr.indexOf(item);
    if (idx !== -1) {
      arr.splice(idx, 1);
      state.lastUpdated = Date.now();
      this.persistToDisk(sessionId, state);
    }
    return state;
  }

  clearSection(sessionId: string, section?: keyof HudState): HudState {
    const state = this.getState(sessionId);
    if (section) {
      if (section === "currentTask" || section === "compactedContext") {
        (state as any)[section] = null;
      } else if (section === "keyDecisions" || section === "activeFiles" || section === "notes" || section === "blockers" || section === "nextSteps") {
        (state as any)[section] = [];
      }
    } else {
      state.currentTask = null;
      state.keyDecisions = [];
      state.activeFiles = [];
      state.notes = [];
      state.blockers = [];
      state.nextSteps = [];
    }
    state.lastUpdated = Date.now();
    this.persistToDisk(sessionId, state);
    return state;
  }

  private loadFromDisk(sessionId: string): HudState {
    try {
      const data = Bun.file(`${this.hudDir}/sessions/${sessionId}.json`).jsonSync() as HudState;
      return data;
    } catch {
      return {
        sessionId,
        projectPath: this.ctx.project?.path ?? "",
        lastUpdated: Date.now(),
        currentTask: null,
        keyDecisions: [],
        activeFiles: [],
        notes: [],
        blockers: [],
        nextSteps: [],
        compactedContext: null,
      };
    }
  }

  private persistToDisk(sessionId: string, state: HudState): void {
    Bun.write(
      `${this.hudDir}/sessions/${sessionId}.json`,
      JSON.stringify(state, null, 2),
    ).catch(() => {
      // Silently fail -- in-memory state is still valid
    });
  }
}
```

### 9.3 Extended Plugin Entry Point

```typescript
// src/index.ts (extended)

import type { Plugin } from "@opencode-ai/plugin";
import { getCompactionPrompt } from "./compaction/prompt.js";
import { startContextTracker } from "./context/tracker.js";
import { createHudManager } from "./hud/manager.js";
import { renderHud } from "./hud/renderer.js";
import { createTools } from "./tools.js";

const OpenMemoryPlugin: Plugin = async (ctx) => {
  const contextTracker = startContextTracker(ctx);
  const hudManager = createHudManager(ctx);

  return {
    tool: createTools(ctx, contextTracker, hudManager),

    "experimental.session.compacting": async (_input, output) => {
      output.prompt = getCompactionPrompt();
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;

      const contextInfo = contextTracker.getContextInfo(input.sessionID);
      const hudState = hudManager.getState(input.sessionID);
      const hud = renderHud(hudState, contextInfo);

      output.system.push(hud);
    },

    event: async ({ event }) => {
      contextTracker.handleEvent(event);

      const props = event.properties as Record<string, unknown>;
      if (!props) return;

      // Handle compaction events -- capture summary for HUD
      if (event.type === "session.compacted") {
        const sessionId = props.sessionID as string;
        if (sessionId) {
          // TODO: query latest compaction summary and store in HUD state
          hudManager.markCompacted(sessionId);
        }
      }
    },
  };
};

export default OpenMemoryPlugin;
```

---

## 10. Risks and Open Questions

### 10.1 Token Budget Risk

**Risk**: The HUD adds 300-700 tokens to every system prompt. On a 200k context model, this is negligible (0.15-0.35%). On a 32k context model, it's more significant (0.9-2.2%).

**Mitigation**: The tiered disclosure system (section 4.3) reduces HUD size as context fills. At red/critical levels, the HUD shrinks to ~100-200 tokens.

**Open question**: Should the total HUD token budget be configurable? Some users may have very small context windows and want minimal HUD overhead.

### 10.2 State Drift

**Risk**: The agent forgets to update HUD sections (e.g., sets `currentTask` but never clears it when done). Stale state is worse than no state because it misleads the agent.

**Mitigation**:
1. Include a `lastUpdated` timestamp in the HUD. If `lastUpdated` is more than N minutes ago (configurable), add a note: "HUD state may be stale (last updated X min ago)."
2. Include guidance in the HUD text: "Use hud_update to refresh stale sections."
3. On session start, show a brief "new session" message that encourages the agent to update the HUD.

### 10.3 Conflicting with AGENTS.md Instructions

**Risk**: The HUD tells the agent something that conflicts with AGENTS.md or other system instructions. For example, AGENTS.md says "never use global state" but the HUD maintains global state.

**Mitigation**: The HUD should be presented as an **advisory** display, not as instructions. Use neutral language: "Current task: X" not "You must complete task X". The agent should treat HUD sections as information, not commands.

### 10.4 File I/O in Hook

**Risk**: The `system.transform` hook is called on every LLM call. If `HudManager.getState()` reads from disk, it adds latency.

**Mitigation**: The manager uses in-memory cache (`Map<string, HudState>`) with file fallback on cache miss. Disk reads only happen on:
- Cold start (first call for a session)
- Plugin reload

Both are infrequent. Normal operation is pure in-memory.

### 10.5 Race Conditions

**Risk**: Tool calls update HUD state while `system.transform` is rendering. If both happen concurrently, the render might see partial state.

**Mitigation**: In the Bun runtime, the event loop is single-threaded. Tool calls and hook invocations are both async, so they don't truly run in parallel -- one completes before the next starts. No race condition concern in practice.

### 10.6 Privacy and Security

**Risk**: HUD state files contain task descriptions, decisions, and notes. These are stored in plaintext JSON under `~/.local/share/opencode/hud/sessions/`.

**Mitigation**: This is the same trust level as the OpenCode database (also plaintext SQLite). No special handling needed, but document that HUD data is unencrypted local storage.

### 10.7 Interaction with Prompt Caching

**Risk**: Dynamic HUD content breaks prompt caching for the second system message block.

**Mitigation**: This is acceptable. The HUD is small (300-700 tokens) and changes are inevitable. The first system block (agent/provider prompt) continues to benefit from caching. Additionally, we can optimize by splitting the HUD into static and dynamic parts:

```typescript
// Static part (cached across calls when unchanged):
output.system.push(renderHudStatic(hudState));  // task, decisions, notes, files

// Dynamic part (changes every call):
output.system.push(renderHudDynamic(contextInfo)); // context percentage, status
```

This is an optimization for Phase 2 or later.

### 10.8 Should HUD Replace the Existing Context Injection?

**Open question**: The current context injection is ~50 tokens. The HUD includes context information and much more. Should we:

A. **Remove the standalone context injection and rely solely on the HUD** (simpler, single source of truth)
B. **Keep both** (context injection is a separate concern, HUD is broader state)
C. **Merge context injection into HUD rendering** (the HUD renderer includes context line)

**Recommendation**: **Option C**. The HUD renderer should include the context status line as its first element. This means we don't push a separate context string and a HUD string -- we push one combined string. This reduces the number of system messages and ensures context status is always at the top of the HUD.

---

## Key File Reference

### OpenCode Core

| File | Relevance to HUD |
|------|-------------------|
| `/workspace/opencode/packages/opencode/src/session/llm.ts` | `system.transform` hook invocation; system prompt assembly and caching |
| `/workspace/opencode/packages/opencode/src/session/prompt.ts` | Session loop where LLM calls happen; reminders injection |
| `/workspace/opencode/packages/opencode/src/session/compaction.ts` | Compaction event (`session.compacted`) for HUD updates |
| `/workspace/opencode/packages/opencode/src/session/todo.ts` | `todo.updated` event for task tracking in HUD |
| `/workspace/opencode/packages/opencode/src/file/index.ts` | `file.edited` event for active file tracking |
| `/workspace/opencode/packages/opencode/src/session/message-v2.ts` | `message.updated` event (already used by ContextTracker) |
| `/workspace/opencode/packages/plugin/src/index.ts` | Plugin SDK type definitions; `Hooks` interface |

### Open-Memory Plugin

| File | Relevance to HUD |
|------|-------------------|
| `/workspace/@alkdev/open-memory/src/index.ts` | Plugin entry point; extend `system.transform` and `event` hooks |
| `/workspace/@alkdev/open-memory/src/tools.ts` | Tool definitions; add HUD operations to memory router |
| `/workspace/@alkdev/open-memory/src/context/tracker.ts` | `ContextTracker` pattern; model for `HudManager` |
| `/workspace/@alkdev/open-memory/src/context/thresholds.ts` | Threshold constants for tiered disclosure |
| `/workspace/@alkdev/open-memory/src/history/queries.ts` | `bun:sqlite` read-only query pattern for HUD data |

### New Files (Proposed)

| File | Purpose |
|------|---------|
| `src/hud/manager.ts` | `HudManager` class -- in-memory map + file persistence |
| `src/hud/renderer.ts` | `renderHud()` function -- tiered disclosure rendering |
| `src/hud/sections.ts` | Section rendering functions (status, decisions, files, notes) |

### Related Research

| Document | Relevance |
|----------|-----------|
| `/workspace/@alkdev/open-memory/docs/research/01-compaction-architecture.md` | System prompt injection mechanics, hook behavior, caching |
| `/workspace/@alkdev/open-memory/docs/research/02-agent-definitions-pattern.md` | Declarative definition pattern (YAML frontmatter + body), `.opencode/` directory conventions |
| `/workspace/@alkdev/open-memory/docs/research/03-handlebars-bun-compatibility.md` | Template rendering decision (use template literals, not Handlebars) |

---

*Research conducted 2026-04-22. Architecture based on open-memory v1.0.0 and OpenCode plugin SDK v1.1.3.*
