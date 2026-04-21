export const formatSessionList = (rows: Record<string, unknown>[]): string => {
  if (rows.length === 0) return "No sessions found.";

  const lines: string[] = ["# Recent Sessions\n"];
  lines.push("| ID | Title | Updated | Messages |");
  lines.push("|----|-------|---------|----------|");

  for (const row of rows) {
    const id = String(row.id ?? "");
    const title = String(row.title ?? "untitled").slice(0, 40);
    const updated = String(row.updated ?? "");
    const msgs = String(row.msgs ?? "0");

    lines.push(`| ${id} | ${title} | ${updated} | ${msgs} |`);
  }

  lines.push("");
  lines.push(
    'Use memory({tool: "messages", args: {sessionId: "..."}}) to read the full conversation.',
  );

  return lines.join("\n");
};

export const formatMessageList = (
  rows: Record<string, unknown>[],
  options?: { maxLength?: number },
): string => {
  if (rows.length === 0) return "No messages found.";

  const maxLen = options?.maxLength ?? 2000;

  const lines: string[] = ["# Conversation\n"];

  for (const row of rows) {
    const role = String(row.role ?? "unknown");
    const time = String(row.time ?? "");
    const text = String(row.text ?? "");
    const icon = role === "user" ? "👤" : role === "assistant" ? "🤖" : "📝";
    const header = `${icon} **${role}** _${time}_`;

    lines.push(header);
    const truncated = text.length > maxLen;
    lines.push(
      truncated
        ? text.slice(0, maxLen) +
            `\n... (${text.length} chars total, use maxLength or message tool for full content)`
        : text,
    );
    lines.push("---");
  }

  return lines.join("\n");
};

export const formatSingleMessage = (
  row: Record<string, unknown>,
  options?: { maxLength?: number },
): string => {
  const maxLen = options?.maxLength ?? 8000;
  const role = String(row.role ?? "unknown");
  const time = String(row.time ?? "");
  const text = String(row.text ?? "");
  const icon = role === "user" ? "👤" : role === "assistant" ? "🤖" : "📝";

  const truncated = text.length > maxLen;
  const displayText = truncated
    ? text.slice(0, maxLen) +
      `\n... (${text.length} chars total, increase maxLength for full content)`
    : text;

  return [`${icon} **${role}** _${time}_\n`, displayText].join("\n");
};
