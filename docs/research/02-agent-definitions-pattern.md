# Agent Definitions Pattern: Research & HUD/AUI Implications

## 1. alkhub_ts Agent Definitions

### 1.1 Directory Structure

Agent definitions in alkhub_ts live in `.opencode/agents/` as individual Markdown files:

```
.opencode/agents/
├── architect.md
├── architecture-reviewer.md
├── code-reviewer.md
├── coordinator.md
├── decomposer.md
├── implementation-specialist.md
├── poc-specialist.md
└── research-specialist.md
```

### 1.2 File Format: YAML Frontmatter + Markdown Body

Each file uses gray-matter frontmatter for structured metadata and a Markdown body for the system prompt:

```yaml
---
description: Short one-liner describing the agent's purpose
mode: primary | subagent
temperature: 0.2
---

You are the **Role Name**, [long-form system prompt...]
```

**Frontmatter fields observed across all 8 agents:**

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `description` | string | yes | One-line summary shown in agent picker / `@` autocomplete |
| `mode` | `"primary"` \| `"subagent"` | yes | Whether the agent appears as a top-level mode or only as a subagent |
| `temperature` | number | sometimes | Model sampling temperature override |

**Additional fields supported by OpenCode but not used in alkhub_ts:**

| Field | Type | Purpose |
|-------|------|---------|
| `model` | string | Override the model (e.g., `"anthropic/claude-sonnet-4"`) |
| `variant` | string | Model variant to use when using this agent's configured model |
| `top_p` | number | Top-p sampling override |
| `hidden` | boolean | Hide from the UI (for internal agents like compaction, title) |
| `color` | string | Hex color or theme color for UI display |
| `steps` | number | Maximum agentic iterations before forcing text-only response |
| `permission` | object | Per-tool permission rules (allow/deny/ask) |
| `options` | object | Arbitrary provider options merged into model calls |
| `disable` | boolean | Disable a built-in agent |

### 1.3 Agent Roles in alkhub_ts

The 8 agents form a coordinated workflow:

| Agent | Mode | Role |
|-------|------|------|
| `coordinator` | primary | Orchestrates parallel task execution across worktrees |
| `architect` | primary | Creates/maintains architecture specifications (WHAT & WHY) |
| `decomposer` | primary | Breaks architecture into atomic, dependency-ordered tasks |
| `implementation-specialist` | primary | Executes atomic tasks in isolated worktrees |
| `poc-specialist` | primary | Creates proof-of-concepts in research worktrees |
| `research-specialist` | subagent | Researches technical topics, documents findings |
| `code-reviewer` | subagent | Reviews code quality at checkpoints |
| `architecture-reviewer` | subagent | Reviews architecture specs for gaps/risks |

Key patterns:
- **Primary agents** are selectable top-level modes in the TUI
- **Subagents** are invoked only via the `@agent-name` syntax or programmatically via the task tool
- Each agent has a detailed system prompt defining its workflow, constraints, and output format
- The coordinator describes both current (open-coordinator plugin) and future (hub operations) execution models

### 1.4 Agent Prompt Design Patterns

The alkhub_ts agents demonstrate several reusable patterns:

1. **Environment scoping**: Implementation specialist and POC specialist both specify exact worktree paths and use `workdir` parameter patterns
2. **Workflow phases**: Structured numbered steps (1. Load Task → 2. Verify → 3. Implement → 4. Verify → 5. Update → 6. Commit)
3. **Safe Exit protocol**: Standardized failure handling with status updates and escalation
4. **Role constraints**: "You coordinate, you do not implement" — explicit boundaries
5. **Template outputs**: Structured output templates (review reports, research documents)
6. **Tool gating**: References to specific tools available to the agent

---

## 2. OpenCode Agent System (Source Code Analysis)

### 2.1 Agent Schema (`Agent.Info`)

Defined in `/workspace/opencode/packages/opencode/src/agent/agent.ts` (lines 27-52):

```typescript
export const Info = z.object({
  name: z.string(),
  description: z.string().optional(),
  mode: z.enum(["subagent", "primary", "all"]),
  native: z.boolean().optional(),
  hidden: z.boolean().optional(),
  topP: z.number().optional(),
  temperature: z.number().optional(),
  color: z.string().optional(),
  permission: Permission.Ruleset,
  model: z.object({
    modelID: ModelID.zod,
    providerID: ProviderID.zod,
  }).optional(),
  variant: z.string().optional(),
  prompt: z.string().optional(),
  options: z.record(z.string(), z.any()),
  steps: z.number().int().positive().optional(),
})
```

### 2.2 Config Schema (`Config.Agent`)

Defined in `/workspace/opencode/packages/opencode/src/config/config.ts` (lines 466-553):

```typescript
export const Agent = z.object({
  model: ModelId.optional(),
  variant: z.string().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  prompt: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),  // deprecated
  disable: z.boolean().optional(),
  description: z.string().optional(),
  mode: z.enum(["subagent", "primary", "all"]).optional(),
  hidden: z.boolean().optional(),
  options: z.record(z.string(), z.any()).optional(),
  color: z.union([z.string().regex(...), z.enum([...])]).optional(),
  steps: z.number().int().positive().optional(),
  maxSteps: z.number().int().positive().optional(),  // deprecated
  permission: Permission.optional(),
}).catchall(z.any()).transform(...)
```

Notable: The `catchall(z.any())` means any unknown fields in the YAML frontmatter or JSON config are swept into `options`. This is by design — it allows arbitrary per-agent configuration that gets merged into model call parameters.

### 2.3 Loading Pipeline

Agent definitions are loaded from four directory patterns (in `/workspace/opencode/packages/opencode/src/config/config.ts`, line 209):

```
/.opencode/agent/    (singular)
/.opencode/agents/   (plural)
/agent/              (singular, no dot)
/agents/             (plural, no dot)
```

The loading function `loadAgent()` (lines 189-226):

1. Globs for `*.md` files in all matching directories
2. Parses each file with `ConfigMarkdown.parse()` which uses `gray-matter` to extract YAML frontmatter
3. Extracts the agent name from the file path (stripping directory prefixes and `.md` extension)
4. Combines frontmatter data + markdown body as `prompt`
5. Validates against the `Agent` schema
6. Returns a `Record<string, Agent>` mapping name → config

**Name resolution** (line 211):
```typescript
const patterns = ["/.opencode/agent/", "/.opencode/agents/", "/agent/", "/agents/"]
const file = rel(item, patterns) ?? path.basename(item)
const agentName = trim(file)  // removes .md extension
```

This means:
- `.opencode/agents/coordinator.md` → agent name `"coordinator"`
- `.opencode/agents/nested/child.md` → agent name `"nested/child"`

### 2.4 Merge Strategy

Built-in agents (build, plan, general, explore, compaction, title, summary) are defined in code. User-defined agents from `.opencode/agents/*.md` are merged on top:

```typescript
for (const [key, value] of Object.entries(cfg.agent ?? {})) {
  if (value.disable) {
    delete agents[key]
    continue
  }
  let item = agents[key]
  if (!item) {
    item = agents[key] = {
      name: key,
      mode: "all",
      permission: Permission.merge(defaults, user),
      options: {},
      native: false,
    }
  }
  // Merge each field: prompt, model, temperature, mode, etc.
  item.prompt = value.prompt ?? item.prompt
  item.model = value.model ? Provider.parseModel(value.model) : item.model
  item.variant = value.variant ?? item.variant
  // ... etc
}
```

Key behaviors:
- `disable: true` removes a built-in agent entirely
- If a new name doesn't match a built-in, a fresh agent with `mode: "all"` is created
- Frontmatter fields override built-in values (not deep-merge for most fields)
- Permission configs are merged (not replaced)
- `options` are deep-merged with `mergeDeep()`

### 2.5 System Prompt Assembly

When an LLM call is made, the system prompt is assembled in this order (from `/workspace/opencode/packages/opencode/src/session/llm.ts`, lines 101-126):

```typescript
const system: string[] = []
system.push(
  [
    // 1. Agent-specific prompt OR provider default prompt
    ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
    // 2. Custom system prompt from the call
    ...input.system,
    // 3. Custom system prompt from the user message
    ...(input.user.system ? [input.user.system] : []),
  ]
    .filter((x) => x)
    .join("\n"),
)
```

Then the plugin hook `experimental.chat.system.transform` is triggered, allowing plugins to modify the system prompt array.

After this, additional segments are added (from `/workspace/opencode/packages/opencode/src/session/prompt.ts`, lines 1500-1509):

```typescript
const [skills, env, instructions, modelMsgs] = yield* Effect.all([
  Effect.promise(() => SystemPrompt.skills(agent)),
  Effect.promise(() => SystemPrompt.environment(model)),
  instruction.system(),
  Effect.promise(() => MessageV2.toModelMessages(msgs, model)),
])
const system = [...env, ...(skills ? [skills] : []),
  ...instructions]
```

The full system prompt hierarchy (first message wins position, content accumulates):

1. **Agent prompt** (from `.opencode/agents/*.md` body) — or a model-specific default (anthropic.txt, gpt.txt, etc.)
2. **Custom system** (from plugin hooks, compaction, plan mode injection)
3. **User-provided system prompt** (from the user message)
4. **Plugin modifications** via `experimental.chat.system.transform`
5. **Environment info** (model name, working directory, platform, date)
6. **Skills list** (markdown-formatted available skills)
7. **Instruction files** (AGENTS.md, CLAUDE.md found walking up directory tree)

### 2.6 Agent Name Usage in Messages

The `AgentPart` type (SDK types, line 833-844):
```typescript
export type AgentPart = {
  id: string
  sessionID: string
  messageID: string
  type: "agent"
  name: string           // agent name, e.g. "explore"
  source?: { value: string, start: number, end: number }
}
```

When a user types `@explore` in their message, OpenCode parses this into an `AgentPart`. During prompt processing, if the text contains `@agent-name`, it resolves to the corresponding agent definition, and the subagent is launched via the task tool.

### 2.7 Agent Generation

OpenCode includes an LLM-powered agent generator (`Agent.generate()`). When invoked, it:

1. Collects the list of existing agent names to avoid collisions
2. Uses a structured output call with schema `{ identifier, whenToUse, systemPrompt }`
3. The prompt (`generate.txt`) instructs the model to create an agent configuration

This is used by the `/agent` command in the CLI to dynamically create agents from descriptions.

---

## 3. Relationship Between Agents and Sessions

### 3.1 Agent per Message, Not per Session

Each **user message** carries an `agent` field indicating which agent handled it. This is NOT a session-level property — a single session can switch between agents:

```typescript
// Message info structure (simplified)
interface MessageInfo {
  id: MessageID
  role: "user" | "assistant"
  agent: string       // e.g. "build", "explore", "coordinator"
  model: { providerID, modelID }
  // ...
}
```

From `prompt.ts` line 1593:
```typescript
const agentName = cmd.agent ?? input.agent ?? (yield* agents.defaultAgent())
```

This means:
- A user can type `@explore` mid-conversation to switch to the explore agent for that turn
- The next turn may return to the default agent
- Each message remembers which agent produced it

### 3.2 Agent Switching and Plan Mode

Plan mode has special handling. From `prompt.ts` lines 261-302:
- When switching FROM plan TO build, a system reminder is injected explaining the transition
- When NOT in plan mode but the previous assistant message was from plan, a different reminder is injected
- Plan mode restricts edit permissions

### 3.3 No Agent-Scoped State or Memory

OpenCode does **not** have a concept of "agent state" or "agent-scoped memory". Each agent is stateless — it's defined by its:
- System prompt
- Permission ruleset
- Model configuration
- Tool access

State lives in the **session** (messages, tool results, compaction summaries). The agent definition is purely declarative configuration for how to run LLM calls within a session.

The `options` field on agents supports arbitrary key-value pairs that get merged into LLM call parameters, but these are static configuration, not runtime state.

---

## 4. Relevance to HUD/AUI Concept

### 4.1 Could HUD Sections Be Defined as Declarative Configs?

**Yes — and the agent definition pattern provides a strong analogy.**

An agent definition is essentially:
```yaml
frontmatter (structured metadata) → controls behavior
markdown body (unstructured prompt) → controls content
```

A HUD section definition could follow the same pattern:
```yaml
---
section: context-status
position: top
refresh: on-event          # on-event | on-demand | periodic
priority: 10
collapse-threshold: 70     # percentage above which to always expand
always-show: false
---

Template for rendering this section (can reference data sources)...
```

Just as agent definitions declare their `mode`, `temperature`, and `permission`, HUD definitions would declare their `position`, `refresh strategy`, and `data requirements`.

### 4.2 Declarative vs. Imperative: What Agent Definitions Teach Us

Agent definitions are **declarative configs with a procedural core**:

| Aspect | Agent Definition | HUD Definition (Proposed) |
|--------|-----------------|---------------------------|
| Metadata | YAML frontmatter | YAML frontmatter |
| Content | Markdown system prompt | Markdown template or rendering spec |
| Behavior | Controls LLM call parameters | Controls HUD rendering and data fetching |
| Overrides | Built-in agents can be extended/overridden | Built-in HUD sections could be extended/overridden |
| Merge | `mergeDeep` with priority | Similar merge with project-level overrides |

The critical design insight from OpenCode's agent system: **the same merge strategy that allows `.opencode/agents/*.md` files to override built-in agents could allow `.opencode/hud/*.md` files to override built-in HUD sections**.

### 4.3 Project-Specific HUD Layouts

Different project types could have different HUD layouts, just as different projects have different agent rosters:

```
# A web app project might define:
.opencode/hud/context-bar.md    → Shows token usage, model, cost
.opencode/hud/task-tracker.md   → Shows task progress from tasks/*.md
.opencode/hud/test-runner.md    → Shows test results

# A data pipeline project might define:
.opencode/hud/pipeline-status.md → Shows last pipeline run status
.opencode/hud/data-quality.md    → Shows data quality metrics  
.opencode/hud/context-bar.md     → Override: add data volume info
```

This mirrors how `coordinator.md` uses worktree-specific context that implementation-specialist.md doesn't need.

### 4.4 How Could This Be Done Without Modifying OpenCode Core?

OpenCode's plugin system provides the necessary hooks. The relevant hooks are:

1. **`experimental.chat.system.transform`** — already used by open-memory to inject context status. This hook receives `{ sessionID, model }` and `{ system }` (a mutable array of system prompt strings).

2. **`experimental.session.compacting`** — receives compaction events.

3. **`event`** — receives all SSE events, which include message updates with token counts.

A HUD definition system could work as a **plugin**:

```
@alkdev/open-memory/ (or a separate @alkdev/open-hud plugin)
├── src/
│   ├── index.ts           # Plugin entry
│   ├── hud/
│   │   ├── loader.ts      # Load .opencode/hud/*.md files (like loadAgent)
│   │   ├── renderer.ts    # Render HUD sections into system prompt
│   │   └── sections/      # Built-in section definitions
│   │       ├── context.md
│   │       ├── tasks.md
│   │       └── git.md
│   └── hooks/
│       ├── system-prompt.ts  # experimental.chat.system.transform
│       └── event.ts         # SSE event processing for data
```

The key architectural insight: **we don't need OpenCode to render a visual HUD**. Instead, we inject structured status information into the system prompt, and the agent's response becomes the "rendered" HUD. This is exactly what open-memory already does with context percentage injection.

### 4.5 Proposed HUD Definition Schema

Drawing from the agent definition pattern:

```yaml
---
# Section identity
name: context-status           # unique identifier (from filename)
description: Context window usage and status

# Rendering behavior
position: header               # header | sidebar | footer | inline
priority: 10                   # lower = shown first
refresh: on-event              # on-event | on-demand | periodic | once
collapse-threshold: 70         # auto-collapse below this threshold

# Data requirements
data-sources:
  - context-tracker            # from this plugin
  - session-info                # from OpenCode

# Rendering constraints
max-length: 500                # max chars in system prompt injection
always-show: false             # always inject, even when collapsed

# Agent targeting
agents:                        # which agents should see this section
  - build
  - plan
  # (null/undefined = all agents)
---

## Context Status

Your context window is at {{context.percentage}}% usage ({{context.tokens}} / {{context.limit}} tokens).

{{#if context.status.critical}}
⚠️ CRITICAL: Context usage above 92%. Consider using memory_compact() immediately.
{{else if context.status.red}}
🔴 Context usage above 85%. Consider compacting soon.
{{else if context.status.yellow}}
🟡 Context usage above 70%. Monitor but proceed normally.
{{else}}
🟢 Context usage is healthy (below 70%).
{{/if}}
```

### 4.6 Comparison: Agent Definitions vs. HUD Definitions

| Dimension | Agent Definition | HUD Definition (Proposed) |
|-----------|-----------------|--------------------------|
| **Format** | YAML frontmatter + Markdown body | YAML frontmatter + template body |
| **Loading** | `.opencode/agents/*.md` | `.opencode/hud/*.md` (or plugin-scoped) |
| **Merge** | Built-in + config + user overrides | Built-in + project overrides |
| **Scope** | Per-agent (LLM call config) | Per-section (status display config) |
| **State** | None (stateless config) | Reactive data sources |
| **Output** | System prompt content | System prompt injection (agent-visible) |
| **Trigger** | User selects `@agent-name` | System prompt assembly (every turn) |
| **Data** | Static config only | Dynamic (from SSE events, DB queries) |

### 4.7 Key Differences and Challenges

1. **Statefulness**: Agent definitions are purely static config. HUD sections need reactive data (context percentage, session counts, git status). This requires runtime state management that doesn't exist in the agent system.

2. **Rendering**: Agent definitions are consumed by the LLM as freeform text. HUD sections could be either:
   - **Prompt-injection style** (like current open-memory context injection) — the agent "sees" the HUD
   - **Tool-response style** — the agent queries HUD data via a memory tool
   - The agent definition pattern suggests prompt-injection, but tool-response may be better for on-demand data

3. **Conditional visibility**: Agent definitions have `hidden` and `mode` fields. HUD sections need richer conditions — "show only when context > 70%" or "show only when git has uncommitted changes". This is more complex than the simple boolean/enum agent system.

4. **Layout ordering**: Agent definitions don't have a concept of ordering (they're selected by name). HUD sections need positional semantics (which section appears first, which is collapsible, etc.).

5. **Refresh cadence**: Agent configs are loaded once. HUD data may need to refresh on events, periodically, or on-demand. The agent system has no equivalent concept.

### 4.8 Recommended Approach

**Phase 1: Mimic the agent definition loading pattern exactly.**

Store HUD section templates as `.opencode/hud/*.md` with YAML frontmatter. Load them using the same `gray-matter` + glob pattern that OpenCode uses for agents. Inject them via the `experimental.chat.system.transform` hook.

This requires no OpenCode core changes and establishes the file format convention.

**Phase 2: Add data binding and conditional rendering.**

Extend the template body with simple `${variable}` interpolation. The plugin maintains a reactive data store (context tracker, session stats) that fills in these variables at system prompt assembly time.

**Phase 3: Consider proposing first-class HUD support to OpenCode.**

If the pattern proves valuable, propose that OpenCode adds a `.opencode/hud/` directory as a first-class concept, similar to `.opencode/agents/` and `.opencode/skills/`. The loading infrastructure already exists (glob + gray-matter + merge). The new concept is just the "HUD section" schema with its position, refresh, and data-source metadata.

---

## 5. Summary of Findings

### Agent Definition System (OpenCode)

- **Format**: YAML frontmatter + Markdown body in `.opencode/agents/*.md`
- **Schema**: `AgentConfig` with fields for model, prompt, mode, permissions, options, etc.
- **Loading**: Glob + gray-matter parsing, merged over built-in agents
- **Resolution**: Agent name derived from filename (with directory prefix for nested files)
- **Usage**: Selected per-message via `@agent-name` syntax or as default agent
- **System prompt**: Agent's `prompt` field becomes the primary system prompt (replacing provider default)
- **No state**: Agents are stateless config; state lives in sessions

### alkhub_ts Agent Definitions

- **8 agents** forming a coordinated workflow (architect → decomposer → implementation-specialist)
- **Rich prompts**: Detailed workflows, constraints, output templates, tool references
- **Pattern**: Primary agents for top-level use, subagents for specialized delegation
- **Innovation**: Worktree-scoped environment constraints, safe exit protocols, AAR processes

### HUD/AUI Implications

- The agent definition pattern (YAML frontmatter + template body, glob loading, merge strategy) translates directly to HUD section definitions
- Agent definitions prove the pattern works for declarative, project-specific configuration
- The key difference is state: agents are static config, HUD needs reactive data
- Can be implemented as a plugin without OpenCode core changes using `experimental.chat.system.transform`
- The same `.opencode/` directory convention would make HUD definitions discoverable and project-specific
