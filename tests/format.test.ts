import { describe, expect, test } from "bun:test";
import { formatMessageList, formatSessionList } from "../src/history/format";

describe("formatSessionList", () => {
  test("returns message for empty list", () => {
    expect(formatSessionList([])).toBe("No sessions found.");
  });

  test("formats sessions as markdown table", () => {
    const rows = [
      { id: "ses_abc123def", title: "Test Session", updated: "2024-01-15 10:30:00", msgs: 12 },
    ];
    const result = formatSessionList(rows);
    expect(result).toContain("# Recent Sessions");
    expect(result).toContain("| ID | Title | Updated | Messages |");
    expect(result).toContain("ses_abc123de...");
    expect(result).toContain("Test Session");
  });

  test("truncates long IDs and titles", () => {
    const rows = [
      {
        id: "ses_verylongidthatshouldbetruncated1234567890",
        title: "A very long title that should be truncated for display",
        updated: "2024-01-15",
        msgs: 5,
      },
    ];
    const result = formatSessionList(rows);
    expect(result).toContain("ses_verylong...");
  });

  test("handles untitled sessions", () => {
    const rows = [{ id: "ses_1", title: null, updated: "2024-01-15", msgs: 0 }];
    const result = formatSessionList(rows);
    expect(result).toContain("untitled");
  });
});

describe("formatMessageList", () => {
  test("returns message for empty list", () => {
    expect(formatMessageList([])).toBe("No messages found.");
  });

  test("formats messages with roles and timestamps", () => {
    const rows = [
      { role: "user", time: "2024-01-15 10:00:00", text: "Hello" },
      { role: "assistant", time: "2024-01-15 10:00:05", text: "Hi there" },
    ];
    const result = formatMessageList(rows);
    expect(result).toContain("# Conversation");
    expect(result).toContain("user");
    expect(result).toContain("assistant");
    expect(result).toContain("Hello");
    expect(result).toContain("Hi there");
  });

  test("truncates long text", () => {
    const longText = "x".repeat(3000);
    const rows = [{ role: "assistant", time: "2024-01-15", text: longText }];
    const result = formatMessageList(rows);
    expect(result.length).toBeLessThan(longText.length + 200);
  });
});
