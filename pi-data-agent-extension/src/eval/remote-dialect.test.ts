import { afterEach, describe, expect, it, vi } from "vitest";
import { DuckDBEngine } from "../engine/duckdb.js";
import {
  attachRemote,
  getActiveRemoteConnections,
  removeRemoteConnection,
  REMOTE_DIALECTS,
} from "../engine/remote-dialect.js";

const spec = {
  dialect: REMOTE_DIALECTS.mysql,
  alias: "timeout_regression",
  host: "localhost",
  port: 3306,
  database: "fixture",
  user: "reader",
  password: "fixture-only-password",
  timeoutMs: 12345,
};

function makeEngine(failPrefix?: string, cleanupFails = false) {
  const engine = new DuckDBEngine({ dbPath: ":memory:", outputDir: ".", previewLimit: 10 });
  const exec = vi.spyOn(engine, "exec").mockImplementation(async (sql) => {
    if (failPrefix && sql.startsWith(failPrefix)) throw new Error("injected failure");
    if (cleanupFails && sql.startsWith("DROP SECRET")) throw new Error("cleanup failure");
    return { rowCount: 0 };
  });
  return { engine, exec };
}

afterEach(() => {
  removeRemoteConnection(spec.alias);
  vi.restoreAllMocks();
});

describe("remote connection lifecycle", () => {
  it("rejects timeout setup failure before creating credentials or attaching", async () => {
    const { engine, exec } = makeEngine("SET ");
    await expect(attachRemote(engine, spec)).rejects.toThrow("injected failure");
    expect(exec.mock.calls.map(([sql]) => sql)).toEqual([
      "INSTALL mysql",
      "LOAD mysql",
      "SET mysql_query_timeout_max_ms = 12345",
    ]);
    expect(getActiveRemoteConnections().some((item) => item.alias === spec.alias)).toBe(false);
  });

  it("sets timeout before a temporary secret and read-only attachment", async () => {
    const { engine, exec } = makeEngine();
    const result = await attachRemote(engine, spec);
    const sql = exec.mock.calls.map(([statement]) => statement);
    expect(sql[2]).toBe("SET mysql_query_timeout_max_ms = 12345");
    expect(sql[3]).toMatch(/^CREATE OR REPLACE TEMPORARY SECRET /);
    expect(sql[4]).toBe('ATTACH \'\' AS "timeout_regression" (TYPE mysql, SECRET "pi_data_agent_mysql_timeout_regression", READ_ONLY)');
    expect(sql.filter((statement) => statement.includes(spec.password))).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(spec.password);
    expect(getActiveRemoteConnections()).toContainEqual(result);
  });

  it.each(["CREATE OR REPLACE", "ATTACH "])("cleans up after %s failure", async (prefix) => {
    const { engine, exec } = makeEngine(prefix);
    await expect(attachRemote(engine, spec)).rejects.toThrow("injected failure");
    expect(exec).toHaveBeenLastCalledWith('DROP SECRET IF EXISTS "pi_data_agent_mysql_timeout_regression"');
    expect(getActiveRemoteConnections().some((item) => item.alias === spec.alias)).toBe(false);
  });

  it("preserves the original failure when secret cleanup also fails", async () => {
    const { engine } = makeEngine("ATTACH ", true);
    await expect(attachRemote(engine, spec)).rejects.toThrow("injected failure");
  });

  it.each(["INSTALL ", "LOAD "])("provides local extension guidance after %s failure", async (prefix) => {
    const { engine, exec } = makeEngine(prefix);
    await expect(attachRemote(engine, spec)).rejects.toThrow("extension_directory");
    expect(exec.mock.calls.some(([sql]) => /^(CREATE|ATTACH|SET)/.test(sql))).toBe(false);
    expect(getActiveRemoteConnections().some((item) => item.alias === spec.alias)).toBe(false);
  });
});
