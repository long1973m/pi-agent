/**
 * S5.1 connect_database 验收测试
 *
 * 运行: npx tsx src/eval/connect-database.test.ts
 *
 * 覆盖:
 * - CDB1: 成功连接 SQLite 数据库
 * - CDB2: 返回正确的 schema / tables
 * - CDB3: db_type 不支持被拒绝
 * - CDB4: 越界路径被拦截
 * - CDB5: 文件不存在被拒绝
 * - CDB6: 重复 attach 同一文件（DETACH + 重新 ATTACH）
 */

import { loadConfig, toSecurityConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { SecurityChecker } from "../security.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { createConnectDatabaseTool } from "../tools/connect-database.js";
import type { ToolContext } from "../tools/tool-context.js";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { execSync } from "node:child_process";

const TEST_CWD = cwd();
const EVAL_DIR = join(TEST_CWD, ".pi-data-agent", "eval");

const mockCtx = {
  ui: null,
  cwd: TEST_CWD,
  sessionManager: { getBranch: () => [], appendEntry: () => {} },
} as any;

async function runConnectDatabaseTests(): Promise<void> {
  console.log("=== S5.1 Connect Database Tests ===\n");
  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, detail?: string): void {
    if (condition) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.log(`  ❌ ${name}${detail ? `: ${detail}` : ""}`);
      failed++;
    }
  }

  // Setup
  const config = loadConfig();
  const persistence = new PersistenceManager(config.globalConfigDir, config.projectConfigDir);
  persistence.saveDataDictionary([], "project");
  persistence.saveQueryMemory({ maxEntries: 5, entries: [] }, "project");

  const engine = new DuckDBEngine({
    dbPath: config.dbPath,
    previewLimit: config.previewLimit,
    outputDir: config.outputDir,
  });
  await engine.init();

  const security = new SecurityChecker(toSecurityConfig(config));

  const toolContext: ToolContext = {
    engine,
    security,
    persistence,
    cwd: config.cwd,
    config,
    dataDictionary: {} as any,
    queryMemory: {} as any,
  };

  const getRuntime = () => toolContext;
  const connectTool = createConnectDatabaseTool({ getRuntime });

  // 创建一个 SQLite 测试数据库（用 sqlite3 CLI，避免 DuckDB 扩展权限问题）
  mkdirSync(EVAL_DIR, { recursive: true });
  const sqlitePath = join(EVAL_DIR, "test_connect.db");
  // 清理可能残留的旧数据库
  try { unlinkSync(sqlitePath); } catch { /* ignore */ }

  execSync(`sqlite3 '${sqlitePath}' "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER); INSERT INTO users VALUES (1, 'Alice', 30), (2, 'Bob', 25); CREATE TABLE orders (id INTEGER, user_id INTEGER, amount REAL); INSERT INTO orders VALUES (1, 1, 99.5), (2, 2, 150.0);"`);

  // ========================================================================
  // CDB1: 成功连接 SQLite 数据库
  // ========================================================================
  console.log("\n[CDB1] Connect SQLite success");
  const result1 = await connectTool.execute("test-cdb1", { db_type: "sqlite", file_path: sqlitePath }, undefined, undefined, mockCtx);
  assert("connect: success flag", (result1.details as any)?.success === true);
  assert("connect: alias is test_connect", (result1.details as any)?.alias === "test_connect");

  // ========================================================================
  // CDB2: 返回正确的 schema / tables
  // ========================================================================
  console.log("\n[CDB2] Schema / tables returned");
  const tables = (result1.details as any)?.tables;
  assert("schema: has tables array", Array.isArray(tables));
  assert("schema: 2 tables", tables.length === 2);
  const tableNames = tables.map((t: any) => t.name);
  assert("schema: has users table", tableNames.includes("users"));
  assert("schema: has orders table", tableNames.includes("orders"));

  // 检查 users 表的列
  const usersTable = tables.find((t: any) => t.name === "users");
  const userCols = usersTable?.columns.map((c: any) => c.name);
  assert("schema: users has id", userCols?.includes("id"));
  assert("schema: users has name", userCols?.includes("name"));
  assert("schema: users has age", userCols?.includes("age"));

  // ========================================================================
  // CDB3: db_type 不支持被拒绝
  // ========================================================================
  console.log("\n[CDB3] Unsupported db_type rejected");
  const result3 = await connectTool.execute("test-cdb3", { db_type: "mysql", file_path: sqlitePath }, undefined, undefined, mockCtx);
  assert("unsupported: rejected", (result3.details as any)?.error === "unsupported_db_type");

  // ========================================================================
  // CDB4: 越界路径被拦截
  // ========================================================================
  console.log("\n[CDB4] Out-of-bounds path blocked");
  const result4 = await connectTool.execute("test-cdb4", { db_type: "sqlite", file_path: "/etc/passwd" }, undefined, undefined, mockCtx);
  assert("oob: blocked", (result4.details as any)?.blocked === true);

  // ========================================================================
  // CDB5: 文件不存在被拒绝
  // ========================================================================
  console.log("\n[CDB5] Non-existent file rejected");
  const result5 = await connectTool.execute("test-cdb5", { db_type: "sqlite", file_path: join(EVAL_DIR, "nonexistent.db") }, undefined, undefined, mockCtx);
  assert("not found: rejected", (result5.details as any)?.error === "file_not_found");

  // ========================================================================
  // CDB6: 重复 attach 同一文件（DETACH + 重新 ATTACH）
  // ========================================================================
  console.log("\n[CDB6] Re-attach same file");
  const result6 = await connectTool.execute("test-cdb6", { db_type: "sqlite", file_path: sqlitePath, alias: "test_connect" }, undefined, undefined, mockCtx);
  assert("re-attach: success", (result6.details as any)?.success === true);
  assert("re-attach: same alias", (result6.details as any)?.alias === "test_connect");

  // Cleanup
  await engine.close();
  try { unlinkSync(sqlitePath); } catch { /* ignore */ }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runConnectDatabaseTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
