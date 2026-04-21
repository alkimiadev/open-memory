# @alkdev/open-memory

An [OpenCode](https://opencode.ai) plugin that gives agents access to their own session history, context window awareness, and compaction control.

## Why

OpenCode agents have three problems this plugin solves:

1. **Context blindness** — agents don't know how much of their context window is used until they hit the wall at ~92% and automatic compaction fires with no warning
2. **No history access** — agents can't look back at previous sessions, search past conversations, or read compaction checkpoints — the data exists in SQLite but there's no tool interface for it
3. **Disorienting compaction** — the default compaction prompt says "summarize for another agent" when it's the same agent continuing, losing task context at an unpredictable point

Open-memory fixes all three: agents get real-time context awareness injected into their system prompt, read-only tools for browsing session history, and control over *when* compaction happens with a prompt that preserves self-continuity.

## Install

```bash
bun add @alkdev/open-memory
```

Add to your `opencode.json`:

```json
{
  "plugin": ["@alkdev/open-memory"]
}
```

## Tools

The plugin exposes exactly 2 tools to keep context bloat minimal:

### `memory`

Read-only router for all introspection operations. Call with `{tool: "<name>", args: {...}}`.

| Operation | Description |
|-----------|-------------|
| `memory({tool: "help"})` | Full reference with examples |
| `memory({tool: "summary"})` | Quick counts: projects, sessions, messages, todos |
| `memory({tool: "sessions"})` | List recent sessions (filterable by project) |
| `memory({tool: "messages", args: {sessionId: "..."}})` | Read a session's conversation |
| `memory({tool: "search", args: {query: "..."}})` | Search across all conversations |
| `memory({tool: "compactions", args: {sessionId: "..."}})` | View compaction checkpoints |
| `memory({tool: "context"})` | Current context window usage |
| `memory({tool: "plans"})` | List or read saved plan files |

### `memory_compact`

Trigger compaction on the current session. Summarizes the conversation to free context space. Use when context is getting high (80%+) to control *when* compaction happens, rather than waiting for automatic compaction at 92%.

The compaction prompt is rewritten to emphasize self-continuity — the agent summarizes for itself, not "for another agent" — using a structured template (Goal, Instructions, Discoveries, Accomplished, Relevant files, Notes).

## Context Awareness

The plugin injects context status into the agent's system prompt:

- **Green** (<70%): Healthy
- **Yellow** (70-85%): Advises considering compaction
- **Red** (85-92%): Strongly recommends compacting at next break
- **Critical** (>92%): Imminent automatic compaction

The agent always knows its context state without having to call a tool.

## Recommended AGENTS.md Additions

For agents to effectively use these tools, add guidance to your project's `AGENTS.md`:

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

## Development

```bash
bun install
bun run build        # bun build + tsc declarations
bun run typecheck    # tsc --noEmit
bun run lint         # biome check
bun run test         # bun test (16 tests)
```

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for detailed design decisions and technical reference.

## License

MIT OR Apache-2.0 at your option. See [LICENSE-MIT](LICENSE-MIT) or [LICENSE-APACHE](LICENSE-APACHE).