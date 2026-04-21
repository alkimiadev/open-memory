export const formatSessionList = (rows: Record<string, unknown>[]): string => {
  if (rows.length === 0) return "No sessions found.";

  const lines: string[] = ["# Recent Sessions\n"];
  lines.push("| ID | Title | Updated | Messages |");
  lines.push("|----|-------|---------|----------|");

  for (const row of rows) {
    const id = `${String(row.id ?? "").slice(0, 12)}...`;
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

export const formatMessageList = (rows: Record<string, unknown>[]): string => {
  if (rows.length === 0) return "No messages found.";

  const lines: string[] = ["# Conversation\n"];

  for (const row of rows) {
    const role = String(row.role ?? "unknown");
    const time = String(row.time ?? "");
    const text = String(row.text ?? "");
    const icon = role === "user" ? "👤" : role === "assistant" ? "🤖" : "📝";
    const header = `${icon} **${role}** _${time}_`;

    lines.push(header);
    lines.push(text.slice(0, 2000));
    lines.push("---");
  }

  return lines.join("\n");
};
