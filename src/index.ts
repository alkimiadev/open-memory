import type { Plugin } from "@opencode-ai/plugin";
import { getCompactionPrompt } from "./compaction/prompt.js";
import { startContextTracker } from "./context/tracker.js";
import { createTools } from "./tools.js";

const OpenMemoryPlugin: Plugin = async (ctx) => {
  const contextTracker = startContextTracker(ctx);

  return {
    tool: createTools(ctx, contextTracker),

    "experimental.session.compacting": async (_input, output) => {
      output.prompt = getCompactionPrompt();
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;

      const info = contextTracker.getContextInfo(input.sessionID);
      if (!info) return;

      const statusEmoji =
        info.status === "critical"
          ? "🔴"
          : info.status === "red"
            ? "🟠"
            : info.status === "yellow"
              ? "🟡"
              : "🟢";

      const advisory =
        info.status === "critical"
          ? "Context is nearly full. Use memory_compact immediately if possible."
          : info.status === "red"
            ? "Context is running low. Use memory_compact at your next natural break point."
            : info.status === "yellow"
              ? "Context usage is getting high. Consider memory_compact when convenient."
              : null;

      const lines = [
        `${statusEmoji} Context: ${info.percentage}% used (${info.usedTokens.toLocaleString()} / ${info.limitTokens.toLocaleString()} tokens, ${info.model})`,
      ];

      if (advisory) {
        lines.push(advisory);
      }

      output.system.push(lines.join("\n"));
    },

    event: async ({ event }) => {
      contextTracker.handleEvent(event);
    },
  };
};

export default OpenMemoryPlugin;
