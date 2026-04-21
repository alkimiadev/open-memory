import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { ContextTracker } from "./context/tracker.js";
import { formatMessageList, formatSessionList } from "./history/format.js";
import { runQuery } from "./history/queries.js";
import { searchConversations } from "./history/search.js";

const z = tool.schema;

const DATA_ROOT = process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share/opencode`;

type ToolArgs = Record<string, unknown>;

const HELP_TEXT = `# Memory Tools

Call \`memory({tool: "<name>", args: {...}})\` to use one.

| Tool | Description | Key args |
|------|-------------|----------|
| summary | Count of projects, sessions, messages, todos | — |
| sessions | List recent sessions, optionally filtered by project | limit, projectPath |
| messages | Read messages from a session as formatted conversation | sessionId, limit |
| search | Text search across all conversations | query, limit |
| compactions | List/read compaction checkpoints for a session | sessionId, read (1-based index) |
| context | Current context window usage (% , tokens, status) | — |
| plans | List or read saved plan files | read (filename) |
| help | Show this reference, or details for a specific tool | tool |

Examples:
- \`memory({tool: "search", args: {query: "safetensors"}})\`
- \`memory({tool: "compactions", args: {sessionId: "ses_abc", read: 1}})\`
- \`memory({tool: "help", args: {tool: "search"}})\``;

const TOOL_HELP: Record<string, string> = {
  summary: `**summary** — Quick counts: projects, sessions, messages, todos. No args needed.`,
  sessions: `**sessions** — List recent sessions with titles, update times, message counts.
Args: limit (number, default 10), projectPath (string, optional filter by worktree path).`,
  messages: `**messages** — Read messages from a specific session as formatted conversation.
Args: sessionId (string, required), limit (number, default 50).`,
  search: `**search** — Text search across all conversations. Returns matching snippets with session references.
Args: query (string, required), limit (number, default 10).`,
  compactions: `**compactions** — List compaction checkpoints for a session. Compactions are summaries created when context was freed. Use 'read' to get the full summary text — these act as checkpoints showing what was important at that point.
Args: sessionId (string, required), read (number, optional 1-based index to read full summary).`,
  context: `**context** — Current context window usage: percentage, token counts, model, status (green/yellow/red/critical). No args needed.`,
  plans: `**plans** — List or read saved plan files from OpenCode's plans directory.
Args: read (string, optional filename to read full content). Lists all plans if omitted.`,
  help: `**help** — Show available tools and usage. Args: tool (string, optional tool name for details).`,
};

type MemoryHandler = (
  args: ToolArgs,
  context: { sessionID?: string },
  ctx: PluginInput,
  tracker: ContextTracker,
) => string | Promise<string>;

const handlers: Record<string, MemoryHandler> = {
  help(args) {
    if (args.tool && typeof args.tool === "string") {
      return (
        TOOL_HELP[args.tool] ??
        `Unknown tool: ${args.tool}. Call memory({tool: "help"}) for the full list.`
      );
    }
    return HELP_TEXT;
  },

  summary() {
    try {
      const rows = runQuery<Record<string, unknown>>(`
        SELECT 'projects', COUNT(*) FROM project
        UNION ALL SELECT 'sessions (main)', COUNT(*) FROM session WHERE parent_id IS NULL
        UNION ALL SELECT 'sessions (total)', COUNT(*) FROM session
        UNION ALL SELECT 'messages', COUNT(*) FROM message
        UNION ALL SELECT 'todos', COUNT(*) FROM todo
      `);
      if (!rows || rows.length === 0) return "No data found.";

      const lines = ["# OpenCode Memory Summary\n"];
      for (const row of rows) {
        const values = Object.values(row);
        lines.push(`- **${values[0]}**: ${values[1]}`);
      }
      return lines.join("\n");
    } catch (err) {
      return `Failed to query database: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  sessions(args) {
    const limit = (args.limit as number) ?? 10;
    const projectPath = args.projectPath as string | undefined;

    try {
      type SessionRow = {
        id: string;
        title: string;
        project?: string;
        updated: string;
        msgs: number;
      };
      let rows: SessionRow[];

      if (projectPath) {
        rows = runQuery<SessionRow>(
          `SELECT s.id, COALESCE(s.title, 'untitled') AS title,
                  datetime(s.time_updated/1000, 'unixepoch', 'localtime') AS updated,
                  (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msgs
           FROM session s JOIN project p ON p.id = s.project_id
           WHERE p.worktree = $projectPath AND s.parent_id IS NULL
           ORDER BY s.time_updated DESC LIMIT $limit`,
          { $projectPath: projectPath, $limit: limit },
        );
      } else {
        rows = runQuery<SessionRow>(
          `SELECT s.id, COALESCE(s.title, 'untitled') AS title,
                  COALESCE(p.name, CASE WHEN p.worktree = '/' THEN '(global)' ELSE REPLACE(p.worktree, RTRIM(p.worktree, REPLACE(p.worktree, '/', '')), '') END) AS project,
                  datetime(s.time_updated/1000, 'unixepoch', 'localtime') AS updated,
                  (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msgs
           FROM session s LEFT JOIN project p ON p.id = s.project_id
           WHERE s.parent_id IS NULL ORDER BY s.time_updated DESC LIMIT $limit`,
          { $limit: limit },
        );
      }

      if (!rows || rows.length === 0) return "No sessions found.";
      return formatSessionList(rows);
    } catch (err) {
      return `Failed to query sessions: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  messages(args) {
    const sessionId = args.sessionId as string;
    const limit = (args.limit as number) ?? 50;
    if (!sessionId) return "sessionId is required.";

    try {
      type MessageRow = { role: string; time: string; text: string };
      const rows = runQuery<MessageRow>(
        `SELECT json_extract(m.data, '$.role') AS role,
                datetime(m.time_created/1000, 'unixepoch', 'localtime') AS time,
                GROUP_CONCAT(json_extract(p.data, '$.text'), char(10)) AS text
         FROM message m LEFT JOIN part p ON p.message_id = m.id AND json_extract(p.data, '$.type') = 'text'
         WHERE m.session_id = $sessionId GROUP BY m.id ORDER BY m.time_created ASC LIMIT $limit`,
        { $sessionId: sessionId, $limit: limit },
      );
      if (!rows || rows.length === 0) return `No messages found for session ${sessionId}.`;
      return formatMessageList(rows);
    } catch (err) {
      return `Failed to query messages: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  search(args) {
    const query = args.query as string;
    const limit = (args.limit as number) ?? 10;
    if (!query) return "query is required.";

    try {
      return searchConversations(query, limit);
    } catch (err) {
      return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  compactions(args) {
    const sessionId = args.sessionId as string;
    const read = args.read as number | undefined;
    if (!sessionId) return "sessionId is required.";

    try {
      type CompactionMeta = {
        compaction_msg_id: string;
        compaction_time: number;
        time: string;
        is_auto: number;
        overflow: number;
      };
      type SummaryRow = { summary_text: string };

      const compactions = runQuery<CompactionMeta>(
        `SELECT cp_msg.id AS compaction_msg_id, cp_msg.time_created AS compaction_time,
                datetime(cp_msg.time_created/1000, 'unixepoch', 'localtime') AS time,
                COALESCE(json_extract(cp_part.data, '$.auto'), 0) AS is_auto,
                COALESCE(json_extract(cp_part.data, '$.overflow'), 0) AS overflow
         FROM part cp_part JOIN message cp_msg ON cp_msg.id = cp_part.message_id
         WHERE cp_msg.session_id = $sessionId AND json_extract(cp_part.data, '$.type') = 'compaction'
         ORDER BY cp_msg.time_created ASC`,
        { $sessionId: sessionId },
      );

      if (!compactions || compactions.length === 0) return "No compactions found for this session.";

      if (read !== undefined) {
        const idx = read - 1;
        if (idx < 0 || idx >= compactions.length)
          return `Invalid compaction index. Session has ${compactions.length} compaction(s). Use 1-${compactions.length}.`;
        const comp = compactions[idx];
        const summaryRows = runQuery<SummaryRow>(
          `SELECT json_extract(p.data, '$.text') AS summary_text FROM message m
           JOIN part p ON p.message_id = m.id
           WHERE m.session_id = $sessionId AND json_extract(m.data, '$.role') = 'assistant'
             AND json_extract(p.data, '$.type') = 'text' AND m.time_created > $compactionTime
           ORDER BY m.time_created ASC LIMIT 1`,
          { $sessionId: sessionId, $compactionTime: comp.compaction_time },
        );
        const summaryText = summaryRows?.[0]?.summary_text ?? "(no summary text found)";
        return [
          `# Compaction ${read}`,
          `Time: ${comp.time}`,
          `Auto: ${comp.is_auto ? "yes" : "no"}`,
          `Overflow: ${comp.overflow ? "yes" : "no"}`,
          "",
          summaryText,
        ].join("\n");
      }

      const lines = [
        `# Compactions (${compactions.length})\n`,
        "| # | Time | Auto | Summary |",
        "|---|------|------|---------|",
      ];
      for (let i = 0; i < compactions.length; i++) {
        const comp = compactions[i];
        const summaryRows = runQuery<SummaryRow>(
          `SELECT substr(json_extract(p.data, '$.text'), 1, 150) AS summary_text FROM message m
           JOIN part p ON p.message_id = m.id
           WHERE m.session_id = $sessionId AND json_extract(m.data, '$.role') = 'assistant'
             AND json_extract(p.data, '$.type') = 'text' AND m.time_created > $compactionTime
           ORDER BY m.time_created ASC LIMIT 1`,
          { $sessionId: sessionId, $compactionTime: comp.compaction_time },
        );
        const preview = summaryRows?.[0]?.summary_text
          ? `${summaryRows[0].summary_text.replace(/\n/g, " ").substring(0, 60)}...`
          : "(no summary)";
        lines.push(`| ${i + 1} | ${comp.time} | ${comp.is_auto ? "yes" : "no"} | ${preview} |`);
      }
      lines.push(
        "",
        `Use memory({tool: "compactions", args: {sessionId: "...", read: N}}) to read a full summary.`,
      );
      return lines.join("\n");
    } catch (err) {
      return `Failed to query compactions: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  context(_args, context, _ctx, tracker) {
    if (!context.sessionID) return "No active session.";
    const info = tracker.getContextInfo(context.sessionID);
    if (!info)
      return "No context data available yet. Send a message first to establish context tracking.";

    const statusLabel =
      info.status === "critical"
        ? "CRITICAL — imminent compaction"
        : info.status === "red"
          ? "RED — compact soon"
          : info.status === "yellow"
            ? "YELLOW — consider compacting"
            : "GREEN — healthy";

    const lines = [
      `Context: ${info.percentage}% used`,
      `Tokens: ${info.usedTokens.toLocaleString()} / ${info.limitTokens.toLocaleString()}`,
      `Model: ${info.model}`,
      `Status: ${statusLabel}`,
    ];
    if (info.trend === "growing") lines.push("Trend: Context is growing rapidly.");
    if (info.status === "red" || info.status === "critical")
      lines.push(
        "",
        "Recommendation: Use memory_compact to trigger compaction at a natural break point.",
      );
    return lines.join("\n");
  },

  async plans(args) {
    const plansDir = `${DATA_ROOT}/plans`;

    if (args.read && typeof args.read === "string") {
      try {
        return await Bun.file(`${plansDir}/${args.read}`).text();
      } catch {
        return `Plan file "${args.read}" not found.`;
      }
    }

    try {
      const glob = new Bun.Glob("*.md");
      const files: { name: string; mtime: number; size: number }[] = [];
      for await (const file of glob.scan({ cwd: plansDir })) {
        const stat = await Bun.file(`${plansDir}/${file}`).stat();
        files.push({ name: file, mtime: stat.mtime.getTime(), size: stat.size });
      }
      if (files.length === 0) return "No plans found.";
      files.sort((a, b) => b.mtime - a.mtime);
      const lines = ["# Plans\n", "| File | Size |", "|------|------|"];
      for (const f of files) {
        const sizeStr = f.size > 1024 ? `${(f.size / 1024).toFixed(1)}KB` : `${f.size}B`;
        lines.push(`| ${f.name} | ${sizeStr} |`);
      }
      lines.push(
        "",
        `Use memory({tool: "plans", args: {read: "filename.md"}}) to view a specific plan.`,
      );
      return lines.join("\n");
    } catch {
      return "No plans directory found.";
    }
  },
};

export const createTools = (
  ctx: PluginInput,
  tracker: ContextTracker,
): Record<string, ToolDefinition> => ({
  memory: tool({
    description:
      'Access your session history, context status, compaction checkpoints, and search past conversations. Call with {tool: "help"} to see available operations.',
    args: {
      tool: z
        .string()
        .describe(
          "Operation name: summary, sessions, messages, search, compactions, context, plans, help.",
        ),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Arguments for the operation. Call {tool: "help"} for details.'),
    },
    async execute(input, context) {
      const toolName = input.tool;
      const toolArgs = (input.args as ToolArgs) ?? {};
      const handler = handlers[toolName];
      if (!handler)
        return `Unknown tool: ${toolName}. Call memory({tool: "help"}) for available operations.`;
      try {
        return await handler(toolArgs, context, ctx, tracker);
      } catch (err) {
        return `Error in ${toolName}: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  }),

  memory_compact: tool({
    description:
      "Trigger compaction on the current session. Summarizes the conversation so far to free context space. Use when context is getting full (80%+) to control when compaction happens, rather than letting it fire automatically at 92%.",
    args: {},
    async execute(_args, context) {
      if (!context.sessionID) return "No active session.";

      const info = tracker.getContextInfo(context.sessionID);
      if (info && info.percentage < 50)
        return `Context is only at ${info.percentage}%. Compaction is not needed yet. Consider waiting until 80%+ for best results.`;

      const session = await ctx.client.session.get({ path: { id: context.sessionID } });
      if (session.error) return `Failed to get session: ${session.error}`;

      const messages = await ctx.client.session.messages({ path: { id: context.sessionID } });
      if (messages.error) return `Failed to get messages: ${messages.error}`;

      const lastUserMessage = [...(messages.data ?? [])]
        .reverse()
        .find((m) => m.info.role === "user");

      let providerID = info?.providerID ?? "";
      let modelID = info?.model ?? "";

      if (lastUserMessage) {
        const infoAny = lastUserMessage.info as Record<string, unknown>;
        const modelObj =
          typeof infoAny.model === "object" && infoAny.model !== null
            ? (infoAny.model as Record<string, unknown>)
            : null;
        if (modelObj?.providerID && typeof modelObj.providerID === "string")
          providerID = modelObj.providerID;
        if (modelObj?.modelID && typeof modelObj.modelID === "string") modelID = modelObj.modelID;
      }

      if (!providerID || !modelID)
        return "Cannot determine model for compaction. Please ensure the session has at least one message.";

      try {
        await ctx.client.session.summarize({
          path: { id: context.sessionID },
          body: { providerID, modelID },
        });
        const contextNote = info ? ` (was at ${info.percentage}%)` : "";
        return `Compaction triggered successfully${contextNote}. The session will be summarized and you'll continue with freed context space.`;
      } catch (err) {
        return `Failed to trigger compaction: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  }),
});
