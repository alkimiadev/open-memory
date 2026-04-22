# Compaction Architecture: OpenCode Core & Open-Memory Plugin Integration

## Table of Contents

1. [Overview](#overview)
2. [Compaction in OpenCode Core](#compaction-in-opencode-core)
3. [Plugin Hook System](#plugin-hook-system)
4. [Open-Memory Plugin Integration](#open-memory-plugin-integration)
5. [System Prompt Injection Mechanisms](#system-prompt-injection-mechanisms)
6. [Persistent HUD Feasibility Analysis](#persistent-hud-feasibility-analysis)
7. [Key File Reference](#key-file-reference)

---

## Overview

Compaction is OpenCode's mechanism for freeing context window space. When a session's token usage approaches the model's context limit, the conversation history is summarized: the older messages are replaced with a concise summary that preserves essential context. This allows long-running sessions to continue without hitting provider token limits.

The `@alkdev/open-memory` plugin integrates with this system in three ways:
1. **Custom compaction prompt** via the `experimental.session.compacting` hook (self-continuity instead of "for another agent")
2. **Context awareness** injected into system prompts via `experimental.chat.system.transform`
3. **Proactive compaction triggering** via the `memory_compact` tool (before automatic overflow kicks in)

---

## Compaction in OpenCode Core

### Trigger Conditions

Compaction triggers in two scenarios:

**1. Automatic overflow detection** — checked after every completed assistant message in the session loop:

`/workspace/opencode/packages/opencode/src/session/prompt.ts:1412-1419`
```ts
if (
  lastFinished &&
  lastFinished.summary !== true &&
  (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
) {
  yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
  continue
}
```

**2. Explicit API/tool call** — when `session.summarize()` is called (used by `memory_compact`). This creates a compaction request with `auto: false`.

**3. Provider-initiated** — when the processor detects a "compact" result from the LLM finish reason:

`/workspace/opencode/packages/opencode/src/session/prompt.ts:1542-1549`
```ts
if (result === "compact") {
  yield* compaction.create({
    sessionID,
    agent: lastUser.agent,
    model: lastUser.model,
    auto: true,
    overflow: !handle.message.finish,
  })
}
```

### Overflow Detection (isOverflow)

`/workspace/opencode/packages/opencode/src/session/overflow.ts:8-22`

The overflow check compares total token usage against the model's usable context:

```ts
export function isOverflow(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  if (input.cfg.compaction?.auto === false) return false
  const context = input.model.limit.context
  if (context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write

  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  const usable = input.model.limit.input
    ? input.model.limit.input - reserved
    : context - ProviderTransform.maxOutputTokens(input.model)
  return count >= usable
}
```

Key constants:
- `COMPACTION_BUFFER = 20_000` — default reserved tokens for generation output
- Usable context = `model.inputLimit - reserved` (or `model.contextLimit - maxOutputTokens`)
- Overflow fires when `count >= usable`

Can be disabled via `config.compaction.auto = false`.

### Compaction Flow (step by step)

**Step 1: Create compaction marker**

`SessionCompaction.create()` (`/workspace/opencode/packages/opencode/src/session/compaction.ts:349-372`):

1. Creates a **user message** (`role: "user"`)
2. Attaches a **CompactionPart** (`type: "compaction"`) with `auto` and `overflow` flags
3. Writes both to the database via `session.updateMessage` and `session.updatePart`

```ts
const msg = yield* session.updateMessage({
  id: MessageID.ascending(),
  role: "user",
  model: input.model,
  sessionID: input.sessionID,
  agent: input.agent,
  time: { created: Date.now() },
})
yield* session.updatePart({
  id: PartID.ascending(),
  messageID: msg.id,
  sessionID: msg.sessionID,
  type: "compaction",
  auto: input.auto,
  overflow: input.overflow,
})
```

**Step 2: Detect compaction task in the loop**

On the next iteration of `runLoop`, the compaction part is detected:

`/workspace/opencode/packages/opencode/src/session/prompt.ts:1393-1409`
```ts
if (task?.type === "compaction") {
  const result = yield* compaction.process({
    messages: msgs,
    parentID: lastUser.id,
    sessionID,
    auto: task.auto,
    overflow: task.overflow,
  })
  if (result === "stop") break
  continue
}
```

**Step 3: Process the compaction**

`SessionCompaction.process()` (`/workspace/opencode/packages/opencode/src/session/compaction.ts:141-347`):

1. **Resolves the compaction agent** (a dedicated "compaction" agent with potentially a different model). Falls back to the user message's model if no compaction agent model is configured.

2. **Triggers the `experimental.session.compacting` plugin hook** — allows plugins to customize the prompt:
   ```ts
   const compacting = yield* plugin.trigger(
     "experimental.session.compacting",
     { sessionID: input.sessionID },
     { context: [], prompt: undefined },
   )
   ```

3. **Constructs the compaction prompt** — either the plugin-provided `prompt` or the default:
   ```ts
   const defaultPrompt = `Provide a detailed prompt for continuing our conversation above.
   Focus on information that would be helpful for continuing the conversation...
   The summary that you construct will be used so that another agent can read it and continue the work.
   Do not call any tools. Respond only with the summary text.
   ...`

   const prompt = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
   ```

   **Critical detail**: If `compacting.prompt` is set, it **replaces** the default prompt entirely. If only `compacting.context` strings are appended, they're joined with the default prompt.

4. **Clones messages and applies messages transform hook**:
   ```ts
   const msgs = structuredClone(messages)
   yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
   ```

5. **Converts messages to model format** (stripping media for token efficiency):
   ```ts
   const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, { stripMedia: true })
   ```

6. **Creates an assistant message with `summary: true`**:
   ```ts
   const msg: MessageV2.Assistant = {
     ...
     mode: "compaction",
     agent: "compaction",
     summary: true,
     ...
   }
   ```

7. **Streams the LLM response** — sends the conversation history + the compaction prompt as a user message, with **no tools** (`tools: {}`):
   ```ts
   const result = yield* processor.process({
     user: userMessage,
     agent,
     sessionID: input.sessionID,
     tools: {},
     system: [],
     messages: [
       ...modelMessages,
       { role: "user", content: [{ type: "text", text: prompt }] },
     ],
     model,
   })
   ```

8. **Handles overflow replay** — if this was an overflow compaction, replays the last non-compaction user message so the agent continues the interrupted task.

9. **Publishes the `session.compacted` bus event** on success.

### Compaction's Data in the Database

After compaction, the database contains:

| Table | Record | Key Fields |
|-------|--------|------------|
| `message` | User message (compaction marker) | `data.role = "user"`, contains the CompactionPart |
| `part` | CompactionPart | `data.type = "compaction"`, `data.auto`, `data.overflow` |
| `message` | Assistant message (summary) | `data.summary = true`, `data.agent = "compaction"` |
| `part` | TextPart (summary text) | `data.type = "text"`, `data.text = "<summary content>"` |
| `message` | User message (same parent) | `data.summary.diffs = [...]` (diff stats for work done) |

Additionally, `SessionSummary.summarize()` attaches diff information:

`/workspace/opencode/packages/opencode/src/session/summary.ts:106-133`

This computes file diffs from snapshot checkpoints and stores them on the compaction user message as `info.summary.diffs`.

### Message Filtering After Compaction

`MessageV2.filterCompacted()` (`/workspace/opencode/packages/opencode/src/session/message-v2.ts:903-919`):

After compaction, the session loop uses `filterCompacted` to load only the messages **from the last compaction point forward**. It walks backward through messages until it finds a completed compaction (`assistant.summary === true && finish && !error`), then stops — everything before that point is excluded from the context window:

```ts
export function filterCompacted(msgs: Iterable<MessageV2.WithParts>) {
  const result = [] as MessageV2.WithParts[]
  const completed = new Set<string>()
  for (const msg of msgs) {
    result.push(msg)
    if (
      msg.info.role === "user" &&
      completed.has(msg.info.id) &&
      msg.parts.some((part) => part.type === "compaction")
    )
      break
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
      completed.add(msg.info.parentID)
  }
  result.reverse()
  return result
}
```

### Pruning (Secondary Context Reclamation)

`SessionCompaction.prune()` (`/workspace/opencode/packages/opencode/src/session/compaction.ts:93-139`):

Pruning is a lighter-weight mechanism that doesn't involve an LLM call. It walks backward through tool call outputs, keeping the most recent `PRUNE_PROTECT` (40,000) tokens of tool output, and marking older ones with `part.state.time.compacted = Date.now()`. This causes those tool outputs to be excluded from the context window (the Read tool skips compacted parts).

Constants:
- `PRUNE_MINIMUM = 20_000` — only prune if at least this many tokens can be reclaimed
- `PRUNE_PROTECT = 40_000` — protect this many tokens of recent tool output
- `PRUNE_PROTECTED_TOOLS = ["skill"]` — tools whose output is never pruned
- Can be disabled via `config.compaction.prune = false`

---

## Plugin Hook System

### Plugin Architecture

OpenCode's plugin system is defined in `/workspace/opencode/packages/opencode/src/plugin/index.ts`.

**Plugin type**: `Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>`

Each plugin is a function that receives `PluginInput` (client, project, directory, worktree, serverUrl, shell) and returns a `Hooks` object.

**Hook trigger mechanism** (`/workspace/opencode/packages/opencode/src/plugin/index.ts:235-248`):

```ts
const trigger = Effect.fn("Plugin.trigger")(function* <...>(name, input, output) {
  const s = yield* InstanceState.get(state)
  for (const hook of s.hooks) {
    const fn = hook[name] as any
    if (!fn) continue
    yield* Effect.promise(async () => fn(input, output))
  }
  return output
})
```

**Key behavior**: Hooks are called sequentially in registration order. The `output` object is mutated in place and passed through all hooks. The final (mutated) `output` is what OpenCode uses. This means:
- All registered plugins can modify the same `output` object
- Order of plugin registration matters for conflicts
- Later.plugins see modifications from earlier plugins

### Hook Definitions

The `Hooks` interface is defined in `/workspace/opencode/packages/plugin/src/index.ts:189-276`:

```ts
export interface Hooks {
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  tool?: { [key: string]: ToolDefinition }
  auth?: AuthHook
  provider?: ProviderHook
  "chat.message"?: (...) => Promise<void>
  "chat.params"?: (...) => Promise<void>
  "chat.headers"?: (...) => Promise<void>
  "permission.ask"?: (...) => Promise<void>
  "command.execute.before"?: (...) => Promise<void>
  "tool.execute.before"?: (...) => Promise<void>
  "tool.execute.after"?: (...) => Promise<void>
  "shell.env"?: (...) => Promise<void>
  "tool.definition"?: (...) => Promise<void>
  "experimental.chat.messages.transform"?: (...) => Promise<void>
  "experimental.chat.system.transform"?: (...) => Promise<void>
  "experimental.session.compacting"?: (...) => Promise<void>
  "experimental.text.complete"?: (...) => Promise<void>
}
```

### Compaction Hook

`experimental.session.compacting`:

**Type definition** (`/workspace/opencode/packages/plugin/src/index.ts:264-267`):
```ts
"experimental.session.compacting"?: (
  input: { sessionID: string },
  output: { context: string[]; prompt?: string },
) => Promise<void>
```

**Invocation site** (`/workspace/opencode/packages/opencode/src/session/compaction.ts:184-188`):
```ts
const compacting = yield* plugin.trigger(
  "experimental.session.compacting",
  { sessionID: input.sessionID },
  { context: [], prompt: undefined },
)
```

**How prompt resolution works** (`/workspace/opencode/packages/opencode/src/session/compaction.ts:189-219`):
```ts
const defaultPrompt = `Provide a detailed prompt for continuing our conversation above...`
const prompt = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
```

- If `output.prompt` is set → replaces the default prompt entirely
- If `output.context` has entries → appended after the default prompt
- Both can be combined: a plugin can set `prompt` (for full replacement) OR add `context` strings (for augmentation)

### System Prompt Transform Hook

`experimental.chat.system.transform`:

**Type definition** (`/workspace/opencode/packages/plugin/src/index.ts:251-256`):
```ts
"experimental.chat.system.transform"?: (
  input: { sessionID?: string; model: Model },
  output: { system: string[] },
) => Promise<void>
```

**Primary invocation site** (`/workspace/opencode/packages/opencode/src/session/llm.ts:116-126`):
```ts
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

**How it works**:
- The `system` array initially contains 1 element: the combined agent/provider prompt + system instructions + user instructions
- Plugins can `push()` additional strings onto `system`
- After all plugins run, OpenCode optimizes: if the first element hasn't changed and there are more than 2 elements, it recombines the extras into a second element (for prompt caching purposes — Anthropic and similar providers cache the first system message separately)
- Final system messages are sent as separate `system` role messages to the LLM: `system.map(x => ({ role: "system", content: x }))`

**Secondary invocation** (agent generation, `/workspace/opencode/packages/opencode/src/agent/agent.ts:340`):
```ts
yield* Effect.promise(() =>
  Plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system }),
)
```

**Note**: `sessionID` is optional in the input type. During agent generation, no sessionID is passed. Plugins must handle this gracefully (open-memory already does: `if (!input.sessionID) return;`).

### Event Hook

`event`:

**Type definition** (`/workspace/opencode/packages/plugin/src/index.ts:190`):
```ts
event?: (input: { event: Event }) => Promise<void>
```

**How events reach plugins** (`/workspace/opencode/packages/opencode/src/plugin/index.ts:220-229`):

The plugin system subscribes to the global bus and forwards all events to all loaded plugins:
```ts
yield* bus.subscribeAll().pipe(
  Stream.runForEach((input) =>
    Effect.sync(() => {
      for (const hook of hooks) {
        hook["event"]?.({ event: input as any })
      }
    }),
  ),
  Effect.forkScoped,
)
```

**Event types** the bus publishes (partial list):
- `message.updated` — whenever a message is updated (token counts, status changes)
- `session.compacted` — after compaction completes
- `session.created`, `session.updated`, `session.deleted`
- `session.error`
- `session.diff`
- Various other lifecycle events

The open-memory plugin only cares about `message.updated` events for assistant messages (to track token usage).

### Messages Transform Hook

`experimental.chat.messages.transform`:

**Type definition** (`/workspace/opencode/packages/plugin/src/index.ts:242-250`):
```ts
"experimental.chat.messages.transform"?: (
  input: {},
  output: {
    messages: {
      info: Message
      parts: Part[]
    }[]
  },
) => Promise<void>
```

Called in two places:
- Before compaction LLM call (`/workspace/opencode/packages/opencode/src/session/compaction.ts:221`)
- Before regular LLM processing (`/workspace/opencode/packages/opencode/src/session/prompt.ts:1499`)

---

## Open-Memory Plugin Integration

### Plugin Entry Point

`/workspace/@alkdev/open-memory/src/index.ts`

The plugin registers four hooks:

```ts
return {
  tool: createTools(ctx, contextTracker),                          // 2 tools: memory, memory_compact
  
  "experimental.session.compacting": async (_input, output) => {   // Custom compaction prompt
    output.prompt = getCompactionPrompt();
  },
  
  "experimental.chat.system.transform": async (input, output) => { // Context awareness injection
    // Pushes context % usage + advisory into system prompt
  },
  
  event: async ({ event }) => {                                     // SSE event handling
    contextTracker.handleEvent(event);
  },
};
```

### Custom Compaction Prompt

`/workspace/@alkdev/open-memory/src/compaction/prompt.ts`

The plugin replaces OpenCode's default "summarize for another agent" prompt with a self-continuity prompt:

**OpenCode's default** (at `/workspace/opencode/packages/opencode/src/session/compaction.ts:189-217`):
> "The summary that you construct will be used so that another agent can read it and continue the work."

**Open-Memory's replacement** (`/workspace/@alkdev/open-memory/src/compaction/prompt.ts:1-40`):
> "You are compacting your own session to free context space. You will continue this session after compaction with this summary as your starting context. ... You are summarizing for yourself, not another agent."

The key difference: the default prompt treats compaction as a handoff between agents, while open-memory's prompt frames compaction as self-continuity. The template structure is similar (Goal, Instructions, Discoveries, Accomplished, Relevant files, Notes) but the framing emphasizes "what YOU will need" rather than "what would be helpful for continuing the conversation."

### Context Tracking

`/workspace/@alkdev/open-memory/src/context/tracker.ts`

The `ContextTracker` class:
1. Listens to `message.updated` events for assistant messages
2. Extracts `tokens.input` as the current context size
3. Looks up the model's context limit from config (falls back to 200,000)
4. Calculates a percentage and classifies into status levels

**Event handling** (`/workspace/@alkdev/open-memory/src/context/tracker.ts:64-122`):
```ts
handleEvent(event: Event) {
  if (event.type !== "message.updated") return;
  // Only care about assistant messages
  if (!info || info.role !== "assistant") return;
  // Extract token counts
  const inputTokens = typeof tokens.input === "number" ? tokens.input : 0;
  // Store per-session tracking data
  existing.lastInputTokens = inputTokens;
  // Track trend via rolling window of last 5 readings
}
```

**Threshold classification** (`/workspace/@alkdev/open-memory/src/context/thresholds.ts`):
- Green: < 70%
- Yellow: 70-85%
- Red: 85-92%
- Critical: > 92%

These thresholds are more aggressive than OpenCode's overflow detection (which fires at ~92%+, depending on model limits and config). Open-memory wants the agent to compact *before* automatic overflow.

### System Prompt Injection

`/workspace/@alkdev/open-memory/src/index.ts:16-49`

The plugin injects context status into every LLM call via the system transform hook:

```ts
"experimental.chat.system.transform": async (input, output) => {
  if (!input.sessionID) return;
  const info = contextTracker.getContextInfo(input.sessionID);
  if (!info) return;
  
  const statusEmoji = /* red/orange/yellow/green circle based on status */;
  const advisory = /* actionable advice based on status level */;
  
  const lines = [
    `${statusEmoji} Context: ${info.percentage}% used (${info.usedTokens.toLocaleString()} / ${info.limitTokens.toLocaleString()} tokens, ${info.model})`,
  ];
  if (advisory) lines.push(advisory);
  
  output.system.push(lines.join("\n"));
}
```

**What the agent sees** (example at yellow status):
```
🟡 Context: 75% used (150,000 / 200,000 tokens, anthropic/claude-sonnet-4-20250514)
Context usage is getting high. Consider memory_compact when convenient.
```

This is appended to the `system` array, so it becomes a separate `system` role message in the final prompt. Due to OpenCode's system message rejoining logic (`/workspace/opencode/packages/opencode/src/session/llm.ts:122-126`), it will be merged into the second system message block if the first block (the core prompt) hasn't changed.

### Compaction Tool (memory_compact)

`/workspace/@alkdev/open-memory/src/tools.ts:402-448`

The `memory_compact` tool:
1. Checks if compaction is needed (skips if context < 50%)
2. Gets model info from the last user message or the context tracker
3. Calls `ctx.client.session.summarize()` via `setTimeout(..., 0)` to schedule compaction asynchronously

**Critical timing note** from AGENTS.md:
> `memory_compact` must NOT await `ctx.client.session.summarize()` — it returns immediately and schedules via `setTimeout(() => { ... }, 0)` because compaction cannot start until the tool returns control to the event loop.

This is because compaction requires the session loop to cycle — the current tool call must complete before the compaction marker can be detected.

### Compaction History Querying

`/workspace/@alkdev/open-memory/src/tools.ts:222-302`

The `memory` tool's `compactions` operation queries the database for compaction checkpoints:

1. Finds all `CompactionPart` rows for a session (`part.data.type = 'compaction'`)
2. For each, finds the adjacent assistant message (the summary text)
3. Presents them as navigable checkpoints with 1-based indexing

---

## System Prompt Injection Mechanisms

There are **four distinct mechanisms** for injecting content into the agent's prompt in OpenCode:

### 1. AGENTS.md / CLAUDE.md / CONTEXT.md (Instruction Files)

`/workspace/opencode/packages/opencode/src/session/instruction.ts`

- Files named `AGENTS.md`, `CLAUDE.md`, or `CONTEXT.md` found in the project directory tree
- Also global paths like `~/.config/opencode/AGENTS.md` and `~/.claude/CLAUDE.md`
- Can be configured via `config.instructions` (including remote URLs)
- Loaded as system instructions: prepended with `"Instructions from: <filepath>\n"`
- Injected by `instruction.system()` which feeds into the `system[]` array in `SessionPrompt.runLoop`

**How injected**: As separate elements in the `system` array passed to `LLM.stream`, before plugin hooks fire.

### 2. `experimental.chat.system.transform` Plugin Hook

- Plugins push strings onto `output.system`
- Called in `LLM.stream()` (`/workspace/opencode/packages/opencode/src/session/llm.ts:116`) before the system messages are assembled
- Strings become additional `system` role messages

**Persistence**: Ephemeral — evaluated fresh on every LLM call. The hook is called every time a system prompt is constructed, so injected content is always current but never persists between calls unless the plugin re-injects it.

**Caching behavior**: OpenCode recombines system messages to maintain a 2-part structure for prompt caching (first element = provider prompt, second element = everything else). Plugins that push a single string will have it merged into the second block.

### 3. User Message Parts (Synthetic Text)

`/workspace/opencode/packages/opencode/src/session/prompt.ts:252-386`

- `insertReminders()` adds synthetic text parts to the last user message
- Used for plan mode instructions, build-switch prompts
- These parts have `synthetic: true` to mark them as non-user-authored

**How injected**: Added as parts of user messages, so they appear in the conversation flow rather than the system prompt.

### 4. `experimental.chat.messages.transform` Plugin Hook

- Plugins can modify the `messages` array (clone provided by OpenCode)
- Called before both regular processing and compaction
- Can add, remove, or modify messages

**Persistence**: Transient — modifications apply only to the current LLM call. The database is not modified (a `structuredClone` is used).

---

## Persistent HUD Feasibility Analysis

A "HUD" (heads-up display) is a persistent block of text injected into every system prompt that shows current state: context usage, active task, recent files, etc. Here we analyze how such a feature could be implemented.

### Requirements

1. **Always present**: Must appear in every LLM call's system prompt
2. **Current**: Must reflect latest state (context %, files modified, etc.)
3. **Compact**: Must not consume excessive context tokens itself
4. **After compaction**: Must survive/reappear after compaction (which replaces older messages)

### Existing Mechanism Already Sufficient

The `experimental.chat.system.transform` hook is already called on **every** LLM call. The open-memory plugin already uses it to inject context percentage. This is the natural place for a HUD.

**How it works now** (`/workspace/@alkdev/open-memory/src/index.ts:16-49`):
- Called on every `LLM.stream()` invocation
- Hook receives current sessionID and model
- Plugin pushes strings to `output.system`
- Those strings become `system` role messages in the prompt

### What's Missing for a Rich HUD

Currently, the plugin only injects context percentage. To make a richer HUD, we could add:

| HUD Element | Data Source | Implementation |
|-------------|-------------|----------------|
| Context % | ContextTracker (already tracked) | Already done |
| Active task | Session title / last user message | Query DB or track via events |
| Files recently modified | Snapshot diffs / step-finish parts | Query DB or track via events |
| Compaction count | Count CompactionParts in DB | Query on each system transform call |
| Todo list status | `todo` table in DB | Query on each call |
| Session age | Session creation time | Query on each call |

### Constraints & Considerations

**1. Token cost of the HUD itself**

Every string pushed to `output.system` becomes a `system` role message that counts against context. A 500-character HUD is ~125 tokens. At 200k context that's negligible, but it compounds with every LLM call (no caching for dynamic content).

**2. Prompt caching**

OpenCode optimizes system messages into 2 blocks for caching. The first block is the provider prompt (e.g., Anthropic's system prompt), which rarely changes. The second block contains everything else.

If the HUD content changes between calls (likely — context % changes), it's part of the second block, which won't benefit from caching. This is acceptable but worth noting.

**3. Compaction survival**

The HUD does **not** need to survive compaction as a message — it's injected fresh on every LLM call. Since `experimental.chat.system.transform` is called after compaction (it's called in `LLM.stream()`, which is invoked for every new assistant turn), the HUD will always be present regardless of how many compactions have occurred.

**4. Latency of DB queries**

If the HUD queries the database on every system transform call, there's a risk of adding latency before each LLM call. Since `bun:sqlite` in readonly mode is very fast (sub-millisecond for simple queries), this is likely acceptable for 2-3 simple queries. However, the hook is `async`, so queries must be synchronous or carefully managed.

**Current open-memory implementation**: The `system.transform` hook is synchronous (no DB queries — it reads from the in-memory `ContextTracker`). Adding DB queries would require making the hook `async`.

**5. Event-driven updates vs. on-demand queries**

Two approaches for HUD data:

- **Event-driven**: Track state changes via the `event` hook, maintain in-memory state, inject from memory in `system.transform`. Fast, but requires tracking all relevant events.
- **On-demand**: Query the DB fresh in `system.transform`. Simple, but adds latency and requires async.

The current context tracker uses **event-driven** for token counts (via `message.updated` events). A hybrid approach makes sense: event-driven for high-frequency data (context %, file changes), on-demand for infrequent data (compaction count, session age).

### Recommended Architecture for a HUD

```
┌──────────────────────────────────┐
│         Event Bus (SSE)          │
│  message.updated                 │
│  session.compacted               │
│  session.updated                 │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│      HUD State Manager           │
│  (Event-driven updates)          │
│                                  │
│  - Context % (from ContextTracker│
│  - Recent file changes (track    │
│    step-finish snapshots)        │
│  - Compaction count (increment)  │
│  - Todo status (from events)     │
└────────────┬─────────────────────┘
             │
             ▼
┌──────────────────────────────────┐
│  system.transform hook           │
│  (reads from HUD State Manager)  │
│                                  │
│  1. Format HUD from state        │
│  2. output.system.push(hud)      │
└──────────────────────────────────┘
```

The key insight: the HUD **never needs to persist in the database or in messages**. It's purely an ephemeral system-prompt injection that's reconstructed from live state on every LLM call. This means:
- It automatically survives compaction (injected after compaction)
- It's always up-to-date (injected on every call)
- It doesn't consume context beyond the current call's injection
- It doesn't interfere with the conversation history

### Alternative: Compaction-Time Persistence

If we want information to persist **through compaction** as part of the conversation (not just the system prompt), the `experimental.session.compacting` hook is the mechanism. We can add `context` strings that get appended to the compaction prompt, ensuring the LLM summarizes that information. Or, if using `prompt` (full replacement), the custom prompt template already includes space for such information.

However, this is about ensuring the **compaction summary includes** key information, not about maintaining a live HUD. The HUD is better served by system prompt injection.

---

## Key File Reference

### OpenCode Core

| File | Purpose |
|------|---------|
| `/workspace/opencode/packages/opencode/src/session/compaction.ts` | Compaction orchestration: create marker, process compaction, prune tool outputs |
| `/workspace/opencode/packages/opencode/src/session/overflow.ts` | `isOverflow()` — determines when compaction should trigger |
| `/workspace/opencode/packages/opencode/src/session/summary.ts` | `SessionSummary` — computes diff stats and attaches to compaction messages |
| `/workspace/opencode/packages/opencode/src/session/prompt.ts` | Session loop — detects compaction tasks, triggers overflow check, orchestrates the main agent loop |
| `/workspace/opencode/packages/opencode/src/session/llm.ts` | `LLM.stream()` — builds system prompt, calls `system.transform` hook, sends to provider |
| `/workspace/opencode/packages/opencode/src/session/system.ts` | `SystemPrompt.provider()` — model-specific base prompts |
| `/workspace/opencode/packages/opencode/src/session/instruction.ts` | `Instruction` — AGENTS.md/CLAUDE.md/CONTEXT.md loading |
| `/workspace/opencode/packages/opencode/src/session/processor.ts` | `SessionProcessor` — handles LLM streaming events, step boundaries, context overflow detection |
| `/workspace/opencode/packages/opencode/src/session/message-v2.ts` | `MessageV2` — message/part schemas, `filterCompacted()`, `CompactionPart` definition |
| `/workspace/opencode/packages/opencode/src/session/session.sql.ts` | DB schema — `SessionTable`, `MessageTable`, `PartTable` |
| `/workspace/opencode/packages/opencode/src/plugin/index.ts` | Plugin loading, hook trigger mechanism, bus event subscription |
| `/workspace/opencode/packages/plugin/src/index.ts` | Plugin SDK type definitions — `Hooks`, `PluginInput`, `ToolDefinition` |

### Open-Memory Plugin

| File | Purpose |
|------|---------|
| `/workspace/@alkdev/open-memory/src/index.ts` | Plugin entry — hook registration (compacting, system.transform, event, tools) |
| `/workspace/@alkdev/open-memory/src/tools.ts` | Tool definitions — `memory` (router) and `memory_compact` handlers |
| `/workspace/@alkdev/open-memory/src/compaction/prompt.ts` | Custom compaction prompt template (self-continuity framing) |
| `/workspace/@alkdev/open-memory/src/context/tracker.ts` | `ContextTracker` — SSE event-driven token tracking, per-session context info |
| `/workspace/@alkdev/open-memory/src/context/thresholds.ts` | Threshold constants — green/yellow/red/critical boundaries |
| `/workspace/@alkdev/open-memory/src/history/queries.ts` | `bun:sqlite` read-only DB query helper (lazy singleton) |
| `/workspace/@alkdev/open-memory/src/history/format.ts` | Markdown rendering for message/session output |
| `/workspace/@alkdev/open-memory/src/history/search.ts` | LIKE-based text search across conversations |
