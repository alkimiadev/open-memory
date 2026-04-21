import { describe, expect, test } from "bun:test";
import { formatMessageList, formatSessionList, formatSingleMessage } from "../src/history/format";

describe("formatSessionList", () => {
  test("returns message for empty list", () => {
    expect(formatSessionList([])).toBe("No sessions found.");
  });

  test("formats sessions as markdown table with full IDs", () => {
    const rows = [
      { id: "ses_abc123def", title: "Test Session", updated: "2024-01-15 10:30:00", msgs: 12 },
    ];
    const result = formatSessionList(rows);
    expect(result).toContain("# Recent Sessions");
    expect(result).toContain("| ID | Title | Updated | Messages |");
    expect(result).toContain("ses_abc123def");
    expect(result).toContain("Test Session");
  });

  test("shows full IDs even for long session IDs", () => {
    const rows = [
      {
        id: "ses_verylongidthatshouldnotbetruncated1234567890",
        title: "A very long title that should be truncated for display",
        updated: "2024-01-15",
        msgs: 5,
      },
    ];
    const result = formatSessionList(rows);
    expect(result).toContain("ses_verylongidthatshouldnotbetruncated1234567890");
    expect(result).toContain("A very long title that should be truncat");
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

  test("truncates long text at default maxLength 2000", () => {
    const longText = "x".repeat(3000);
    const rows = [{ role: "assistant", time: "2024-01-15", text: longText }];
    const result = formatMessageList(rows);
    expect(result.length).toBeLessThan(longText.length + 200);
    expect(result).toContain("3000 chars total");
  });

  test("respects custom maxLength", () => {
    const longText = "x".repeat(500);
    const rows = [{ role: "assistant", time: "2024-01-15", text: longText }];
    const result = formatMessageList(rows, { maxLength: 100 });
    expect(result).toContain("500 chars total");
    expect(result.length).toBeLessThan(500);
  });

  test("does not truncate short text", () => {
    const rows = [{ role: "assistant", time: "2024-01-15", text: "Short message" }];
    const result = formatMessageList(rows);
    expect(result).toContain("Short message");
    expect(result).not.toContain("chars total");
  });
});

describe("formatSingleMessage", () => {
  test("formats a single message", () => {
    const row = { role: "assistant", time: "2024-01-15 10:00:00", text: "Hello world" };
    const result = formatSingleMessage(row);
    expect(result).toContain("assistant");
    expect(result).toContain("Hello world");
  });

  test("respects custom maxLength", () => {
    const row = { role: "assistant", time: "2024-01-15", text: "x".repeat(10000) };
    const result = formatSingleMessage(row, { maxLength: 500 });
    expect(result).toContain("10000 chars total");
  });
});
