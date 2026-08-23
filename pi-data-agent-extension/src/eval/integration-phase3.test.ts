/**
 * 阶段3 集成验证 (I3.1, I3.2, I3.3, I3.4)
 *
 * I3.1: 记录查询 → 修改 schema → 召回 → outdated
 * I3.2: 执行错误 SQL → 失败查询写入 memory → category 正确
 * I3.3: 失败查询超 10 条 → 最旧记录删除
 * I3.4: v0.1 回归无退化
 *
 * 运行: npx tsx src/eval/integration-phase3.test.ts
 */

import { loadConfig, toSecurityConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { SecurityChecker } from "../security.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { DataDictionaryManager } from "../hooks/data-dictionary.js";
import { QueryMemoryManager, classifyError } from "../hooks/query-memory.js";
import type { ToolContext } from "../tools/tool-context.js";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

const TEST_CWD = cwd();
const EVAL_DIR = join(TEST_CWD, ".pi-data-agent", "eval");

const mockCtx = {
  ui: null,
  cwd: TEST_CWD,
  sessionManager: { getBranch: () => [], appendEntry: () => {} },
} as any;

async function runIntegrationTests(): Promise<void> {
  console.log("=== Phase 3 Integration Tests (I3.1, I3.2, I3.3, I3.4) ===\n");
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
  // 清理残留的失败查询
  persistence.writeConfig("failed_queries", [], "project");

  const security = new SecurityChecker(toSecurityConfig(config));
  const engine = new DuckDBEngine({
    dbPath: config.dbPath,
    previewLimit: config.previewLimit,
    outputDir: config.outputDir,
  });
  await engine.init();

  const dataDictionary = new DataDictionaryManager(persistence);
  const queryMemory = new QueryMemoryManager(persistence);

  const toolContext: ToolContext = {
    engine,
    security,
    persistence,
    cwd: config.cwd,
    config,
    dataDictionary,
    queryMemory,
  };

  // ========================================================================
  // I3.1: 记录查询 → 修改 schema → 召回 → outdated
  // ========================================================================
  console.log("[I3.1] Schema change → outdated detection");

  // Step 1: 创建表并生成字典
  mkdirSync(EVAL_DIR, { recursive: true });
  const csvPath = join(EVAL_DIR, "i3_test.csv");
  writeFileSync(csvPath, "a,b\n1,2\n3,4\n");
  await engine.exec(`CREATE OR REPLACE TABLE i3_test AS SELECT * FROM read_csv_auto('${csvPath}')`);
  const dict1 = await dataDictionary.ensureDictionary("i3_test", engine);
  const fp1 = dict1.entry.schemaFingerprint ?? "";
  assert("I3.1: initial fingerprint exists", fp1.length > 0);

  // Step 2: 记录一条查询
  queryMemory.setDatasetFingerprint(fp1);
  queryMemory.recordQuery({
    naturalLanguageQuery: "统计 a 的总和",
    sql: "SELECT SUM(a) FROM i3_test",
    datasetFingerprint: fp1,
  });
  assert("I3.1: query recorded", queryMemory.getMemory().entries.length === 1);

  // Step 3: 召回（应返回 1 条，fingerprint 匹配）
  const relevant1 = queryMemory.recallRelevantQueries(3);
  assert("I3.1: 1 relevant query before schema change", relevant1.length === 1);

  // Step 4: 修改 schema — 加一列
  await engine.exec("ALTER TABLE i3_test ADD COLUMN c INTEGER DEFAULT 0");
  await dataDictionary.refreshFingerprint("i3_test", engine);
  const dict2 = dataDictionary.getDictionary("i3_test");
  const fp2 = dict2?.schemaFingerprint;
  assert("I3.1: fingerprint changed after ALTER", fp2 !== fp1);
  assert("I3.1: new fingerprint exists", fp2!.length > 0);

  // Step 5: 更新全局 fingerprint 并召回
  queryMemory.setDatasetFingerprint(fp2!);
  const relevant2 = queryMemory.recallRelevantQueries(3);
  assert("I3.1: 0 relevant queries after schema change", relevant2.length === 0);

  // Step 6: 检查 stale 标注
  const injection = queryMemory.generatePromptInjection();
  assert("I3.1: injection contains Schema Change Detected", injection.includes("Schema Change Detected"));

  // Step 7: 清理
  await engine.exec("DROP TABLE i3_test");

  // ========================================================================
  // I3.2: 执行错误 SQL → 失败查询写入 memory → category 正确
  // ========================================================================
  console.log("\n[I3.2] Failed query → memory → category");

  // 记录各种失败查询
  queryMemory.recordFailedQuery({
    naturalLanguageQuery: "查一个不存在的表",
    sql: "SELECT * FROM nonexistent_table",
    errorMessage: "Binder Error: Table 'nonexistent_table' does not exist",
  });
  queryMemory.recordFailedQuery({
    naturalLanguageQuery: "语法错误的查询",
    sql: "SELEC * FROM dual",
    errorMessage: "Parser Error: syntax error at or near SELEC",
  });
  queryMemory.recordFailedQuery({
    naturalLanguageQuery: "超时查询",
    sql: "SELECT SLEEP(3600)",
    errorMessage: "Query timeout after 30 seconds",
  });

  const failedQueries = queryMemory.getFailedQueries();
  assert("I3.2: 3 failed queries recorded", failedQueries.length === 3);

  const notFoundEntry = failedQueries.find((e) => e.sql === "SELECT * FROM nonexistent_table");
  const syntaxEntry = failedQueries.find((e) => e.sql === "SELEC * FROM dual");
  const timeoutEntry = failedQueries.find((e) => e.sql === "SELECT SLEEP(3600)");

  assert("I3.2: nonexistent → not_found", notFoundEntry?.failureCategory === "not_found");
  assert("I3.2: syntax error → syntax_error", syntaxEntry?.failureCategory === "syntax_error");
  assert("I3.2: timeout → timeout", timeoutEntry?.failureCategory === "timeout");

  // ========================================================================
  // I3.3: 失败查询超 10 条 → 最旧记录删除
  // ========================================================================
  console.log("\n[I3.3] Max 10 failed queries");

  // 再写入 10 条（已有 3 条，共 13 条）
  for (let i = 0; i < 10; i++) {
    queryMemory.recordFailedQuery({
      naturalLanguageQuery: `批量失败 ${i}`,
      sql: `SELECT * FROM extra_${i}`,
      errorMessage: `Table 'extra_${i}' does not exist`,
    });
  }

  const afterTrim = queryMemory.getFailedQueries();
  assert("I3.3: exactly 10 entries after trim", afterTrim.length === 10);
  // 最早的 3 条应被淘汰
  assert("I3.3: first failed query removed", !afterTrim.some((e) => e.sql === "SELECT * FROM nonexistent_table"));
  assert("I3.3: newest present", afterTrim.some((e) => e.sql === "SELECT * FROM extra_9"));

  // ========================================================================
  // I3.4: v0.1 回归无退化
  // ========================================================================
  console.log("\n[I3.4] v0.1 regression check");

  const { createLoadDataTool } = await import("../tools/load-data.js");
  const { createQueryDataTool } = await import("../tools/query-data.js");

  const loadTool = createLoadDataTool({ getRuntime: () => toolContext });
  const queryTool = createQueryDataTool({ getRuntime: () => toolContext });

  // 创建测试数据
  const regCsv = join(EVAL_DIR, "i3_regression.csv");
  writeFileSync(regCsv, "x,y\n10,20\n30,40\n");
  const loadResult = await loadTool.execute("reg", { file_path: regCsv }, undefined, undefined, mockCtx);
  const loadDetails = loadResult.details as Record<string, any> | undefined;
  assert("I3.4: load_data works", loadDetails?.tableName === "i3_regression");

  const queryResult = await queryTool.execute(
    "reg-q", { sql: "SELECT SUM(x) AS total_x FROM i3_regression", user_intent: "统计x总和" },
    undefined, undefined, mockCtx
  );
  const queryDetails = queryResult.details as Record<string, any> | undefined;
  assert("I3.4: query_data works", queryDetails?.totalRowCount === 1);

  // Cleanup
  await engine.close();
  try { unlinkSync(csvPath); } catch {}
  try { unlinkSync(regCsv); } catch {}

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runIntegrationTests().catch((err) => {
  console.error("Integration test error:", err);
  process.exit(1);
});
