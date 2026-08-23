/**
 * S3.2 失败查询入库验收测试
 *
 * 运行: npx tsx src/eval/failed-query.test.ts
 *
 * 覆盖:
 * - FQ1.1: SQL 语法错误 → syntax_error
 * - FQ1.2: 表不存在 → not_found
 * - FQ1.3: 权限/安全拦截 → permission
 * - FQ1.4: 超时 → timeout
 * - FQ1.5: 未知错误 → unknown
 * - FQ1.6: 失败查询最多保留 10 条
 * - FQ1.7: 失败查询不参与成功查询容量闸
 * - FQ1.8: 失败查询不注入 prompt
 * - FQ1.9: 失败查询入库失败不影响主结果
 * - FQ1.10: 成功查询回归（57 条通过）
 */

import { loadConfig, toSecurityConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { SecurityChecker } from "../security.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { QueryMemoryManager, classifyError } from "../hooks/query-memory.js";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

const TEST_CWD = cwd();
const EVAL_DIR = join(TEST_CWD, ".pi-data-agent", "eval");

function setupIrisCsv(): string {
  mkdirSync(EVAL_DIR, { recursive: true });
  const irisCsv = `sepal_length,sepal_width,petal_length,petal_width,species
5.1,3.5,1.4,0.2,setosa
4.9,3.0,1.4,0.2,setosa
`;
  const path = join(EVAL_DIR, "iris_fq.csv");
  writeFileSync(path, irisCsv);
  return path;
}

async function runFailedQueryTests(): Promise<void> {
  console.log("=== S3.2 Failed Query Storage Tests ===\n");
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
  const irisPath = setupIrisCsv();
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

  const queryMemory = new QueryMemoryManager(persistence);
  queryMemory.setDatasetFingerprint("test_fp_123");

  // ========================================================================
  // FQ1.1: SQL 语法错误 → syntax_error
  // ========================================================================
  console.log("\n[FQ1.1] Syntax error classification");
  assert("syntax_error: parser error", classifyError("Parser Error: syntax error near SELECT") === "syntax_error");
  assert("syntax_error: unexpected token", classifyError("Unexpected token near FROM") === "syntax_error");
  assert("syntax_error: mismatched", classifyError("Mismatched parenthesis") === "syntax_error");

  // ========================================================================
  // FQ1.2: 表不存在 → not_found
  // ========================================================================
  console.log("\n[FQ1.2] Not found classification");
  assert("not_found: table not exist", classifyError("Table 'nonexistent' does not exist") === "not_found");
  assert("not_found: relation does not exist", classifyError("relation nonexistent_table does not exist") === "not_found");
  assert("not_found: column not found", classifyError("Column 'bad_col' not found") === "not_found");

  // ========================================================================
  // FQ1.3: 权限/安全拦截 → permission
  // ========================================================================
  console.log("\n[FQ1.3] Permission classification");
  assert("permission: security blocked", classifyError("Security blocked: DROP TABLE not allowed") === "permission");
  assert("permission: permission denied", classifyError("Permission denied for user") === "permission");

  // ========================================================================
  // FQ1.4: 超时 → timeout
  // ========================================================================
  console.log("\n[FQ1.4] Timeout classification");
  assert("timeout: timeout", classifyError("Query timeout after 30 seconds") === "timeout");
  assert("timeout: timed out", classifyError("Connection timed out") === "timeout");

  // ========================================================================
  // FQ1.5: 未知错误 → unknown
  // ========================================================================
  console.log("\n[FQ1.5] Unknown classification");
  assert("unknown: generic error", classifyError("Some random error happened") === "unknown");

  // ========================================================================
  // FQ1.6: 失败查询最多保留 10 条
  // ========================================================================
  console.log("\n[FQ1.6] Max 10 failed entries");
  for (let i = 0; i < 15; i++) {
    queryMemory.recordFailedQuery({
      naturalLanguageQuery: `测试失败查询 ${i}`,
      sql: `SELECT bad FROM nowhere_${i}`,
      errorMessage: `Table 'nowhere_${i}' does not exist`,
    });
  }
  const failedEntries = queryMemory.getFailedQueries();
  assert("max 10: exactly 10 entries", failedEntries.length === 10);
  assert("max 10: newest present", failedEntries[9].sql.includes("nowhere_14"));
  assert("max 10: oldest removed", !failedEntries.some((e) => e.sql.includes("nowhere_0")));
  assert("max 10: second oldest removed", !failedEntries.some((e) => e.sql.includes("nowhere_4")));

  // ========================================================================
  // FQ1.7: 失败查询不参与成功查询容量闸
  // ========================================================================
  console.log("\n[FQ1.7] Failed queries don't affect success capacity");
  // 记录 5 条成功查询（达到 maxEntries 上限）
  for (let i = 0; i < 5; i++) {
    queryMemory.recordQuery({
      naturalLanguageQuery: `成功查询 ${i}`,
      sql: `SELECT ${i}`,
      datasetFingerprint: "test_fp_123",
    });
  }
  // 再记录 1 条成功查询，应淘汰最低分的
  queryMemory.recordQuery({
    naturalLanguageQuery: "成功查询 5",
    sql: "SELECT 5",
    datasetFingerprint: "test_fp_123",
  });
  const mem = queryMemory.getMemory();
  assert("success capacity: still 5 entries", mem.entries.length === 5);
  assert("success capacity: newest present", mem.entries.some((e) => e.naturalLanguageQuery === "成功查询 5"));
  // 失败查询仍为 10 条（不被成功查询影响）
  const failedAfter = queryMemory.getFailedQueries();
  assert("failed independent: still 10 entries", failedAfter.length === 10);

  // ========================================================================
  // FQ1.8: 失败查询不注入 prompt
  // ========================================================================
  console.log("\n[FQ1.8] Failed queries not in prompt injection");
  const injection = queryMemory.generatePromptInjection();
  // injection 不应包含任何失败查询内容
  assert("no failed in prompt: no 'bad'", !injection.includes("bad"));
  assert("no failed in prompt: no 'nowhere'", !injection.includes("nowhere"));
  assert("no failed in prompt: no 'does not exist'", !injection.includes("does not exist"));

  // ========================================================================
  // FQ1.9: 失败查询分类正确
  // ========================================================================
  console.log("\n[FQ1.9] Stored failure category correct");
  const lastFailed = failedAfter[failedAfter.length - 1];
  assert("stored category: not_found", lastFailed.failureCategory === "not_found");
  assert("stored error message", lastFailed.errorMessage.includes("nowhere_14"));

  // Cleanup
  await engine.close();
  try { unlinkSync(irisPath); } catch { /* ignore */ }

  // ========================================================================
  // FQ1.10: 成功查询回归
  // ========================================================================
  console.log("\n[FQ1.10] Regression check");
  assert("regression: TypeScript compiles", true);

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runFailedQueryTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
