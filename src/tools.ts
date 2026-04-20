import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { ContextTracker } from "./context/tracker.js";
import { formatMessageList, formatSessionList } from "./history/format.js";
import { runQuery } from "./history/queries.js";
import { searchConversations } from "./history/search.js";

const z = tool.schema;

const DATA_ROOT = process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share/opencode`;

export const createTools = (
  ctx: PluginInput,
  tracker: ContextTracker,
): Record<string, ToolDefinition> => ({
  memory_context: tool({
    description:
      "Check current session context window usage. Shows percentage used, token counts, model limit, and status (green/yellow/red/critical). Use when you need to understand how close you are to automatic compaction.",
    args: {},
    async execute(_args, context) {
      if (!context.sessionID) {
        return "No active session.";
      }
      const info = tracker.getContextInfo(context.sessionID);
      if (!info) {
        return "No context data available yet. Send a message first to establish context tracking.";
      }

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

      if (info.trend === "growing") {
        lines.push("Trend: Context is growing rapidly.");
      }

      if (info.status === "red" || info.status === "critical") {
        lines.push("");
        lines.push(
          "Recommendation: Use memory_compact to trigger compaction at a natural break point.",
        );
      }

      return lines.join("\n");
    },
  }),

  memory_compact: tool({
    description:
      "Trigger compaction on the current session. This summarizes the conversation so far to free context space. Use when context is getting full (80%+) and you want to control when compaction happens, rather than letting it fire automatically at 92%.",
    args: {},
    async execute(_args, context) {
      if (!context.sessionID) {
        return "No active session.";
      }

      const info = tracker.getContextInfo(context.sessionID);
      if (info && info.percentage < 50) {
        return `Context is only at ${info.percentage}%. Compaction is not needed yet. Consider waiting until 80%+ for best results.`;
      }

      const session = await ctx.client.session.get({
        path: { id: context.sessionID },
      });
      if (session.error) {
        return `Failed to get session: ${session.error}`;
      }

      const messages = await ctx.client.session.messages({
        path: { id: context.sessionID },
      });
      if (messages.error) {
        return `Failed to get messages: ${messages.error}`;
      }

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
        if (modelObj?.providerID && typeof modelObj.providerID === "string") {
          providerID = modelObj.providerID;
        }
        if (modelObj?.modelID && typeof modelObj.modelID === "string") {
          modelID = modelObj.modelID;
        }
      }

      if (!providerID || !modelID) {
        return "Cannot determine model for compaction. Please ensure the session has at least one message.";
      }

      const pid = providerID as string;
      const mid = modelID as string;

      try {
        await ctx.client.session.summarize({
          path: { id: context.sessionID },
          body: { providerID: pid, modelID: mid },
        });

        const contextNote = info ? ` (was at ${info.percentage}%)` : "";
        return `Compaction triggered successfully${contextNote}. The session will be summarized and you'll continue with freed context space.`;
      } catch (err) {
        return `Failed to trigger compaction: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  }),

  memory_summary: tool({
    description:
      "Get a quick summary of your OpenCode local memory: count of projects, sessions, messages, and todos.",
    args: {},
    async execute() {
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
  }),

  memory_sessions: tool({
    description:
      "List recent sessions with titles, update times, and message counts. Optionally filter by project path.",
    args: {
      limit: z.number().optional().describe("Number of sessions to show (default: 10)."),
      projectPath: z.string().optional().describe("Filter to a specific project worktree path."),
    },
    async execute(args) {
      const limit = args.limit ?? 10;

      try {
        type SessionRow = {
          id: string;
          title: string;
          project?: string;
          updated: string;
          msgs: number;
        };

        let rows: SessionRow[];

        if (args.projectPath) {
          rows = runQuery<SessionRow>(
            `
              SELECT
                s.id,
                COALESCE(s.title, 'untitled') AS title,
                datetime(s.time_updated/1000, 'unixepoch', 'localtime') AS updated,
                (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msgs
              FROM session s
              JOIN project p ON p.id = s.project_id
              WHERE p.worktree = $projectPath
                AND s.parent_id IS NULL
              ORDER BY s.time_updated DESC
              LIMIT $limit
            `,
            { $projectPath: args.projectPath, $limit: limit },
          );
        } else {
          rows = runQuery<SessionRow>(
            `
              SELECT
                s.id,
                COALESCE(s.title, 'untitled') AS title,
                COALESCE(p.name, CASE WHEN p.worktree = '/' THEN '(global)' ELSE REPLACE(p.worktree, RTRIM(p.worktree, REPLACE(p.worktree, '/', '')), '') END) AS project,
                datetime(s.time_updated/1000, 'unixepoch', 'localtime') AS updated,
                (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msgs
              FROM session s
              LEFT JOIN project p ON p.id = s.project_id
              WHERE s.parent_id IS NULL
              ORDER BY s.time_updated DESC
              LIMIT $limit
            `,
            { $limit: limit },
          );
        }

        if (!rows || rows.length === 0) {
          return "No sessions found.";
        }
        return formatSessionList(rows);
      } catch (err) {
        return `Failed to query sessions: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  }),

  memory_messages: tool({
    description:
      "Read messages from a specific session. Returns formatted conversation with roles and timestamps.",
    args: {
      sessionId: z.string().describe("Session ID to read messages from."),
      limit: z.number().optional().describe("Number of messages to return (default: 50)."),
    },
    async execute(args) {
      const limit = args.limit ?? 50;

      try {
        type MessageRow = {
          role: string;
          time: string;
          text: string;
        };

        const rows = runQuery<MessageRow>(
          `
            SELECT
              json_extract(m.data, '$.role') AS role,
              datetime(m.time_created/1000, 'unixepoch', 'localtime') AS time,
              GROUP_CONCAT(json_extract(p.data, '$.text'), char(10)) AS text
            FROM message m
            LEFT JOIN part p ON p.message_id = m.id
              AND json_extract(p.data, '$.type') = 'text'
            WHERE m.session_id = $sessionId
            GROUP BY m.id
            ORDER BY m.time_created ASC
            LIMIT $limit
          `,
          { $sessionId: args.sessionId, $limit: limit },
        );
        if (!rows || rows.length === 0) {
          return `No messages found for session ${args.sessionId}.`;
        }
        return formatMessageList(rows);
      } catch (err) {
        return `Failed to query messages: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  }),

  memory_search: tool({
    description:
      "Search across all conversations for a term. Returns matching snippets with session references.",
    args: {
      query: z.string().describe("Search term to find in conversations."),
      limit: z.number().optional().describe("Max results (default: 10)."),
    },
    async execute(args) {
      const limit = args.limit ?? 10;

      try {
        return searchConversations(args.query, limit);
      } catch (err) {
        return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  }),

  memory_plans: tool({
    description: "List saved plan files from OpenCode's plans directory.",
    args: {
      read: z.string().optional().describe("Filename of a specific plan to read (without path)."),
    },
    async execute(args) {
      const plansDir = `${DATA_ROOT}/plans`;

      if (args.read) {
        try {
          const content = await Bun.file(`${plansDir}/${args.read}`).text();
          return content;
        } catch {
          return `Plan file "${args.read}" not found.`;
        }
      }

      try {
        const glob = new Bun.Glob("*.md");
        const files: { name: string; mtime: number; size: number }[] = [];

        for await (const file of glob.scan({ cwd: plansDir })) {
          const stat = await Bun.file(`${plansDir}/${file}`).stat();
          files.push({
            name: file,
            mtime: stat.mtime.getTime(),
            size: stat.size,
          });
        }

        if (files.length === 0) {
          return "No plans found.";
        }

        files.sort((a, b) => b.mtime - a.mtime);

        const lines = ["# Plans\n", "| File | Size |", "|------|------|"];
        for (const f of files) {
          const sizeStr = f.size > 1024 ? `${(f.size / 1024).toFixed(1)}KB` : `${f.size}B`;
          lines.push(`| ${f.name} | ${sizeStr} |`);
        }
        lines.push("", `Use memory_plans with a "read" argument to view a specific plan.`);
        return lines.join("\n");
      } catch {
        return "No plans directory found.";
      }
    },
  }),
});
