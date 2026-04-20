export const runQuery = async (dbUri: string, sql: string): Promise<Record<string, unknown>[]> => {
  const proc = Bun.spawn(["sqlite3", "-json", dbUri, sql], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    throw new Error(`sqlite3 exited with code ${exitCode}: ${stderr}`);
  }

  if (!stdout.trim()) return [];

  try {
    return JSON.parse(stdout) as Record<string, unknown>[];
  } catch {
    throw new Error(`Failed to parse sqlite3 output: ${stdout.slice(0, 200)}`);
  }
};