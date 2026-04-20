import { runQuery } from "./queries.js";

export const searchConversations = async (
  dbUri: string,
  searchTerm: string,
  limit: number,
): Promise<string> => {
  const escaped = searchTerm.replace(/'/g, "''");

  const query = `
    SELECT
      s.id AS session_id,
      COALESCE(s.title, 'untitled') AS title,
      json_extract(m.data, '$.role') AS role,
      datetime(m.time_created/1000, 'unixepoch', 'localtime') AS time,
      substr(json_extract(p.data, '$.text'), 1, 300) AS snippet
    FROM part p
    JOIN message m ON m.id = p.message_id
    JOIN session s ON s.id = m.session_id
    WHERE s.parent_id IS NULL
      AND json_extract(p.data, '$.type') = 'text'
      AND json_extract(p.data, '$.text') LIKE '%${escaped}%'
    ORDER BY m.time_created DESC
    LIMIT ${limit}
  `;

  try {
    const rows = await runQuery(dbUri, query);
    if (!rows || rows.length === 0) {
      return `No results found for "${searchTerm}".`;
    }

    const lines: string[] = [`# Search: "${searchTerm}"\n`];

    for (const row of rows) {
      const sessionId = String(row.session_id ?? "").slice(0, 16);
      const title = String(row.title ?? "untitled");
      const time = String(row.time ?? "");
      const role = String(row.role ?? "unknown");
      const snippet = String(row.snippet ?? "");

      lines.push(`### ${title} (${time})`);
      lines.push(`- Session: \`${sessionId}...\``);
      lines.push(`- Role: ${role}`);
      lines.push(`- Snippet: ${snippet}...`);
      lines.push("");
    }

    lines.push("Use memory_messages with a session ID to read the full conversation.");
    return lines.join("\n");
  } catch (err) {
    return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};