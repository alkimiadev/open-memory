import { Database } from "bun:sqlite";

const getDbPath = (): string => {
  const dataRoot = process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share/opencode`;
  return `${dataRoot}/opencode.db`;
};

let _db: Database | null = null;
let _dbPath: string | null = null;

const getDb = (): Database => {
  const dbPath = getDbPath();
  if (!_db || _dbPath !== dbPath) {
    if (_db) {
      try {
        _db.close(true);
      } catch {
        // ignore
      }
    }
    _db = new Database(dbPath, { readonly: true, create: false });
    _dbPath = dbPath;
  }
  return _db;
};

export const runQuery = <T = Record<string, unknown>>(
  sql: string,
  params?: Record<string, string | number | null>,
): T[] => {
  const db = getDb();
  const stmt = db.prepare(sql);
  if (params) {
    return stmt.all(params) as T[];
  }
  return stmt.all() as T[];
};

export const closeDb = (): void => {
  if (_db) {
    try {
      _db.close(true);
    } catch {
      // ignore close errors
    }
    _db = null;
    _dbPath = null;
  }
};
