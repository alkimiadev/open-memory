import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, runQuery } from "../src/history/queries";

describe("queries module with bun:sqlite", () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "open-memory-test-"));
  const opencodeDir = path.join(tmpDir, "opencode");
  const dbPath = path.join(opencodeDir, "opencode.db");
  const originalXdg = process.env.XDG_DATA_HOME;

  const setup = (): void => {
    mkdirSync(opencodeDir, { recursive: true });
    const db = new Database(dbPath);
    db.run(
      "CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, worktree TEXT, name TEXT, time_updated INTEGER)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS session (id TEXT, project_id TEXT, parent_id TEXT, title TEXT, summary TEXT, time_created INTEGER, time_updated INTEGER)",
    );
    db.run(
      "INSERT OR REPLACE INTO project VALUES ('proj1', '/tmp/test', 'test-project', 1700000000000)",
    );
    db.run(
      "INSERT OR REPLACE INTO session VALUES ('ses_1', 'proj1', NULL, 'Test Session', NULL, 1700000000000, 1700001000000)",
    );
    db.close();
    process.env.XDG_DATA_HOME = opencodeDir;
  };

  const cleanup = (): void => {
    closeDb();
    process.env.XDG_DATA_HOME = originalXdg;
    rmSync(tmpDir, { recursive: true, force: true });
  };

  test("runQuery without parameters", () => {
    setup();
    try {
      type CountRow = { label: string; cnt: number };
      const rows = runQuery<CountRow>("SELECT 'projects' AS label, COUNT(*) AS cnt FROM project");
      expect(rows.length).toBe(1);
      expect(rows[0].cnt).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("runQuery with named parameters", () => {
    setup();
    try {
      type SessionRow = { id: string; title: string };
      const rows = runQuery<SessionRow>("SELECT id, title FROM session WHERE id = $sessionId", {
        $sessionId: "ses_1",
      });
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe("ses_1");
      expect(rows[0].title).toBe("Test Session");
    } finally {
      cleanup();
    }
  });

  test("runQuery opens database read-only", () => {
    setup();
    try {
      type Row = { cnt: number };
      const rows = runQuery<Row>("SELECT COUNT(*) AS cnt FROM session");
      expect(rows[0].cnt).toBe(1);
    } finally {
      cleanup();
    }
  });
});
