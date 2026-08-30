/**
 * Phase 6 — 金标准回归测试
 *
 * 运行: npx tsx src/eval/regression.test.ts
 *
 * 测试覆盖:
 * - S6.1 T1: CSV 加载
 * - S6.1 T2: SQL 查询
 * - S6.1 T3: 大结果处理
 * - S6.1 T4: 安全拦截
 * - S6.2 T5: 主动反问
 * - S6.3: 收敛性
 * - S6.4: 安全层专项
 */

import { loadConfig, toSecurityConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { SecurityChecker } from "../security.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { DataDictionaryManager } from "../hooks/data-dictionary.js";
import { QueryMemoryManager } from "../hooks/query-memory.js";
import { detectAmbiguity } from "../hooks/active-questioning.js";
import { createLoadDataTool } from "../tools/load-data.js";
import { createDescribeDataTool } from "../tools/describe-data.js";
import { createQueryDataTool } from "../tools/query-data.js";
import { createTransformDataTool } from "../tools/transform-data.js";
import { createExportResultTool } from "../tools/export-result.js";
import type { ToolContext } from "../tools/tool-context.js";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { defineScriptSuite } from "./helpers/vitest-suite.js";

const TEST_CWD = cwd();
const EVAL_DIR = join(TEST_CWD, ".pi-data-agent", "eval");

/** 创建金标准数据集 */
function ensureGoldenDatasets(): { irisPath: string; bigPath: string } {
  mkdirSync(EVAL_DIR, { recursive: true });

  // Iris 数据集（150行）
  const irisCsv = `sepal_length,sepal_width,petal_length,petal_width,species
5.1,3.5,1.4,0.2,setosa
4.9,3.0,1.4,0.2,setosa
4.7,3.2,1.3,0.2,setosa
4.6,3.1,1.5,0.2,setosa
5.0,3.6,1.4,0.2,setosa
5.4,3.9,1.7,0.4,setosa
4.6,3.4,1.4,0.3,setosa
5.0,3.4,1.5,0.2,setosa
4.4,2.9,1.4,0.2,setosa
4.9,3.1,1.5,0.1,setosa
7.0,3.2,4.7,1.4,versicolor
6.4,3.2,4.5,1.5,versicolor
6.9,3.1,4.9,1.5,versicolor
5.5,2.3,4.0,1.3,versicolor
6.5,2.8,4.6,1.5,versicolor
5.7,2.8,4.5,1.3,versicolor
6.3,3.3,4.7,1.6,versicolor
4.9,2.4,3.3,1.0,versicolor
6.6,2.9,4.6,1.3,versicolor
5.2,2.7,3.9,1.4,versicolor
6.3,3.3,6.0,2.5,virginica
5.8,2.7,5.1,1.9,virginica
7.1,3.0,5.9,2.1,virginica
6.3,2.9,5.6,1.8,virginica
6.5,3.0,5.8,2.2,virginica
7.6,3.0,6.6,2.1,virginica
4.9,2.5,4.5,1.7,virginica
7.3,2.9,6.3,1.8,virginica
6.7,2.5,5.8,1.8,virginica
6.3,2.8,5.1,1.5,virginica
`;
  const irisPath = join(EVAL_DIR, "iris.csv");
  writeFileSync(irisPath, irisCsv);

  // 大数据集（200行，用于大结果测试）
  const bigRows: string[] = ["id,value,category"];
  for (let i = 0; i < 200; i++) {
    bigRows.push(`${i},${Math.random().toFixed(4)},cat${i % 10}`);
  }
  const bigPath = join(EVAL_DIR, "big.csv");
  writeFileSync(bigPath, bigRows.join("\n"));

  return { irisPath, bigPath };
}

/** 模拟 ExtensionContext */
const mockCtx = {
  ui: null,
  cwd: TEST_CWD,
  sessionManager: { getBranch: () => [], appendEntry: () => {} },
} as any;

async function runRegressionTests(): Promise<void> {
  console.log("=== Phase 6 Golden Standard Regression Tests ===\n");
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
  const { irisPath, bigPath } = ensureGoldenDatasets();
  const config = loadConfig();
  // S-1 fail-closed（v0.11）：headless 测试无 UI，写操作需显式放行（spec v0.11 §13）
  config.autoConfirmWrite = true;
  const persistence = new PersistenceManager(config.globalConfigDir, config.projectConfigDir);
  persistence.saveDataDictionary([], "project");
  persistence.saveQueryMemory({ maxEntries: 5, entries: [] }, "project");

  const security = new SecurityChecker(toSecurityConfig(config));
  const engine = new DuckDBEngine({
    dbPath: config.dbPath,
    previewLimit: config.previewLimit,
    outputDir: config.outputDir,
  });
  await engine.init();

  const dataDictionary = new DataDictionaryManager(persistence);
  const queryMemory = new QueryMemoryManager(persistence);

  const rt: ToolContext = {
    engine,
    security,
    persistence,
    cwd: TEST_CWD,
    config,
    dataDictionary,
    queryMemory,
  };
  const getRuntime = () => rt;

  const loadTool = createLoadDataTool({ getRuntime });
  const describeTool = createDescribeDataTool({ getRuntime });
  const queryTool = createQueryDataTool({ getRuntime });
  const transformTool = createTransformDataTool({ getRuntime });

  // ========================================================================
  // S6.1 T1: CSV 加载
  // ========================================================================
  console.log("[T1] CSV load — iris.csv");
  const loadResult = await loadTool.execute(
    "test",
    { file_path: irisPath },
    undefined,
    undefined,
    mockCtx
  );
  const loadDetails = loadResult.details as any;
  assert("load returns tableName", loadDetails?.tableName === "iris");
  assert("load returns correct row count", loadDetails?.rowCount === 30);
  assert("load returns correct column count", loadDetails?.columnCount === 5);

  // ========================================================================
  // S6.1 T2: SQL 查询 — "统计各品种的数量"
  // ========================================================================
  console.log("\n[T2] SQL query — species count");
  const queryResult = await queryTool.execute(
    "test",
    {
      sql: "SELECT species, COUNT(*) AS cnt FROM iris GROUP BY species ORDER BY species",
      user_intent: "统计各品种的数量",
      table_name: "iris",
    },
    undefined,
    undefined,
    mockCtx
  );
  const queryDetails = queryResult.details as any;
  assert("query returns 3 groups", queryDetails?.totalRowCount === 3);
  assert("query not truncated", queryDetails?.truncated === false);
  const queryText = String((queryResult.content as any[])?.[0]?.text ?? "");
  assert("query text contains setosa", queryText.includes("setosa"));
  assert("query text contains versicolor", queryText.includes("versicolor"));
  assert("query text contains virginica", queryText.includes("virginica"));

  // ========================================================================
  // S6.1 T3: 大结果处理
  // ========================================================================
  console.log("\n[T3] Big result — preview + CSV export");
  // 先加载大数据集
  await engine.exec(`CREATE OR REPLACE TABLE big AS SELECT * FROM read_csv_auto('${bigPath}')`);
  const bigResult = await engine.executeQueryWithLimit("SELECT * FROM big");
  assert("big result is truncated", bigResult.truncated === true);
  assert("big result has preview", bigResult.returnedRowCount <= 100);
  assert("big result has total count", bigResult.totalRowCount === 200);
  assert("big result has CSV path", bigResult.csvPath !== undefined);

  // ========================================================================
  // S6.1 T4 + S6.4: 安全拦截
  // ========================================================================
  console.log("\n[T4] Security — DROP TABLE blocked");
  const dropResult = await queryTool.execute(
    "test",
    { sql: "DROP TABLE iris", user_intent: "删除 iris 表", table_name: "iris" },
    undefined,
    undefined,
    mockCtx
  );
  const dropDetails = dropResult.details as any;
  assert("DROP TABLE blocked", dropDetails?.blocked === true);

  console.log("\n[T4b] Security — DELETE without WHERE blocked");
  const deleteResult = await queryTool.execute(
    "test",
    { sql: "DELETE FROM iris", user_intent: "删除 iris 所有数据", table_name: "iris" },
    undefined,
    undefined,
    mockCtx
  );
  const deleteDetails = deleteResult.details as any;
  assert("DELETE without WHERE blocked", deleteDetails?.blocked === true);

  console.log("\n[T4c] Security — SELECT passes");
  const selectCheck = security.checkSql("SELECT * FROM iris");
  assert("SELECT passes", selectCheck.action === "allow");

  console.log("\n[T4d] Security — path out of bounds");
  const pathCheck = security.checkPath("/etc/passwd");
  assert("out of bounds path blocked or confirm", pathCheck.action === "block" || pathCheck.action === "confirm");

  // ========================================================================
  // S6.2 T5: 主动反问 — 基于 user_intent 优先检测
  // ========================================================================
  console.log("\n[T5] Active questioning — user_intent priority");

  // T5a: "分析一下这些数据" 一票触发
  const ambig1 = detectAmbiguity("分析一下这些数据", "SELECT species, COUNT(*) FROM iris GROUP BY species");
  assert("open-ended '分析一下这些数据' triggers clarify", ambig1.isAmbiguous === true);
  assert("open-ended has 3 options", (ambig1.suggestedOptions?.length ?? 0) === 3);
  assert("open-ended options include overview",
    ambig1.suggestedOptions?.some((o) => o.id === "overview") ?? false);

  // T5b: "帮我看看这个表" 一票触发
  const ambig2 = detectAmbiguity("帮我看看这个表", "SELECT * FROM iris");
  assert("open-ended '帮我看看这个表' triggers clarify", ambig2.isAmbiguous === true);

  // T5c: 传统模糊关键词 + 维度缺失 触发
  const ambig3 = detectAmbiguity("分析活跃用户", "SELECT * FROM users WHERE active = true");
  assert("ambiguous '分析活跃用户' triggers clarify", ambig3.isAmbiguous === true);

  // T5d: 明确查询不触发
  const clear1 = detectAmbiguity("统计各品种数量", "SELECT species, COUNT(*) FROM iris GROUP BY species");
  assert("clear '统计各品种数量' not ambiguous", clear1.isAmbiguous === false);

  const clear2 = detectAmbiguity("按 species 分组统计数量", "SELECT species, COUNT(*) FROM iris GROUP BY species");
  assert("clear '按 species 分组统计数量' not ambiguous", clear2.isAmbiguous === false);

  // T5e: 明确查询 SQL 也不触发
  const clear3 = detectAmbiguity("统计 iris 总行数", "SELECT COUNT(*) FROM iris");
  assert("clear query '统计 iris 总行数' not ambiguous", clear3.isAmbiguous === false);

  // T5f: options 都有 impliedAssumption
  assert("options have implied assumption",
    ambig1.suggestedOptions?.every((o) => o.impliedAssumption.length > 0) ?? false);

  // ========================================================================
  // T10: query_data 缺少 user_intent 时返回错误
  // ========================================================================
  console.log("\n[T10] query_data missing user_intent");
  const noIntentResult = await queryTool.execute(
    "test",
    { sql: "SELECT 1" },
    undefined,
    undefined,
    mockCtx
  );
  const noIntentDetails = noIntentResult.details as any;
  assert("missing user_intent returns error", noIntentDetails?.error === "missing_user_intent");

  // ========================================================================
  // S6.3: 收敛性 — 同口径不重复反问
  // ========================================================================
  console.log("\n[T6] Convergence — same scope no re-clarify");
  const first = detectAmbiguity("分析活跃用户", "SELECT * FROM users WHERE active = true");
  assert("first ambiguous query triggers", first.isAmbiguous === true);
  const second = detectAmbiguity(
    "统计2024年后注册的用户数量",
    "SELECT COUNT(*) FROM users WHERE created_at > '2024-01-01'"
  );
  assert("convergence: second clear query not ambiguous", second.isAmbiguous === false);

  // ========================================================================
  // S6.4: 安全层专项
  // ========================================================================
  console.log("\n[T7] Security layer comprehensive");

  // 读操作放行
  assert("SELECT allowed", security.checkSql("SELECT * FROM iris").action === "allow");
  assert("DESCRIBE allowed", security.checkSql("DESCRIBE iris").action === "allow");

  // 写操作需确认（v0.11 S-1：autoConfirmWrite=true 时 checkSql 直接返回 allow（自动确认），
  // 三态判定细节由 confirm-gate.test.ts 覆盖；此处用未开自动确认的 checker 验证写分类语义）
  const securityNoAuto = new SecurityChecker({ ...toSecurityConfig(config), autoConfirmWrite: false });
  const insertCheck = securityNoAuto.checkSql("INSERT INTO iris VALUES (1,2,3,4,'test')");
  assert("INSERT requires confirm", insertCheck.action === "confirm");

  // 危险操作拦截
  assert("DROP TABLE blocked", security.checkSql("DROP TABLE iris").action === "block");
  assert("DELETE without WHERE blocked", security.checkSql("DELETE FROM iris").action === "block");

  // CTAS 需确认
  const ctasCheck = securityNoAuto.checkSql("CREATE TABLE tmp AS SELECT * FROM iris");
  assert("CTAS requires confirm", ctasCheck.action === "confirm");

  // 路径安全
  assert("project path allowed", security.checkPath(join(TEST_CWD, "data.csv")).action === "allow");
  assert("out of bounds blocked", security.checkPath("/etc/passwd").action === "block");

  // ========================================================================
  // S6.1 T2b: 数值正确性验证
  // ========================================================================
  console.log("\n[T8] Numerical correctness");
  const countResult = await engine.query("SELECT species, COUNT(*) AS cnt FROM iris GROUP BY species ORDER BY species");
  const rows = countResult.rows;
  assert("setosa count = 10", Number(rows[0][1]) === 10);
  assert("versicolor count = 10", Number(rows[1][1]) === 10);
  assert("virginica count = 10", Number(rows[2][1]) === 10);

  // ========================================================================
  // T9: export_result — CSV 导出
  // ========================================================================
  console.log("\n[T9] export_result — CSV export");
  const exportTool = createExportResultTool({ getRuntime });
  const exportOutputPath = join(EVAL_DIR, "test_export_result.csv");

  // T9a: 正常导出
  const exportResult = await exportTool.execute(
    "test",
    { sql: "SELECT species, COUNT(*) AS cnt FROM iris GROUP BY species", output_path: exportOutputPath },
    undefined,
    undefined,
    mockCtx
  );
  const exportDetails = exportResult.details as any;
  assert("export returns outputPath", exportDetails?.outputPath === exportOutputPath);
  assert("export returns rowCount", exportDetails?.rowCount === 3);
  assert("export returns fileSize > 0", (exportDetails?.fileSize ?? 0) > 0);
  assert("export returns fileSizeFormatted", typeof exportDetails?.fileSizeFormatted === "string");
  assert("export CSV file exists", existsSync(exportOutputPath));

  // T9b: 危险 SQL 不得导出（写操作）
  const exportBlockResult = await exportTool.execute(
    "test",
    { sql: "DROP TABLE iris", output_path: join(EVAL_DIR, "blocked.csv") },
    undefined,
    undefined,
    mockCtx
  );
  const exportBlockDetails = exportBlockResult.details as any;
  assert("export blocks write SQL", exportBlockDetails?.blocked === true);

  // T9c: 不支持格式
  const exportFmtResult = await exportTool.execute(
    "test",
    { sql: "SELECT 1", format: "xlsx", output_path: join(EVAL_DIR, "bad.xlsx") },
    undefined,
    undefined,
    mockCtx
  );
  const exportFmtDetails = exportFmtResult.details as any;
  assert("export rejects unsupported format", exportFmtDetails?.error === "unsupported_format");

  // 清理导出文件
  try { unlinkSync(exportOutputPath); } catch {}

  // ========================================================================
  // T11: 数据字典生命周期
  // ========================================================================
  console.log("\n[T11] Data dictionary lifecycle");

  // T11a: load_data 后自动生成 ai-guessed 字典
  assert("load_data auto-generates dictionary",
    loadDetails.dictionaryGenerated === true);
  const dict = dataDictionary.getDictionary("iris");
  assert("dictionary exists after load_data", dict !== undefined);
  assert("dictionary status is ai-guessed", dict?.status === "ai-guessed");
  assert("dictionary has columns", (dict?.columns?.length ?? 0) > 0);

  // T11b: ai-guessed 状态下 query_data 包含口径提示
  const queryDictResult = await queryTool.execute(
    "test",
    {
      sql: "SELECT species, COUNT(*) AS cnt FROM iris GROUP BY species",
      user_intent: "统计各品种数量",
      table_name: "iris",
    },
    undefined,
    undefined,
    mockCtx
  );
  const queryDictDetails = queryDictResult.details as any;
  const queryDictText = String((queryDictResult.content as any[])?.[0]?.text ?? "");
  assert("query_data returns dict status ai-guessed",
    queryDictDetails?.dictionaryStatus === "ai-guessed");
  assert("query_data content has dict warning",
    queryDictText.includes("ai-guessed"));
  assert("query_data dictWarningProvided is true",
    queryDictDetails?.dictWarningProvided === true);
  assert("query_data shows involved columns",
    queryDictText.includes("species"));

  // T11c: describe_data 后进入 user-confirmed 状态
  const describeResult = await describeTool.execute(
    "test",
    { table_name: "iris" },
    undefined,
    undefined,
    mockCtx
  );
  const describeDetails = describeResult.details as any;
  // 注意：mockCtx.ui.confirm 返回 false（mock 默认），所以状态不会变
  // 但如果我们手动确认，状态应变为 validated
  dataDictionary.confirmDictionary("iris");
  const dictAfterConfirm = dataDictionary.getDictionary("iris");
  assert("dictionary status is validated after confirm",
    dictAfterConfirm?.status === "validated");

  // T11d: validated 状态下 query_data 不再有口径提示
  const queryValidatedResult = await queryTool.execute(
    "test",
    {
      sql: "SELECT species, COUNT(*) AS cnt FROM iris GROUP BY species",
      user_intent: "再统计一次各品种数量",
      table_name: "iris",
    },
    undefined,
    undefined,
    mockCtx
  );
  const queryValidatedText = String((queryValidatedResult.content as any[])?.[0]?.text ?? "");
  const queryValidatedDetails = queryValidatedResult.details as any;
  assert("query_data dict status is validated",
    queryValidatedDetails?.dictionaryStatus === "validated");
  assert("query_data no warning when validated",
    !queryValidatedText.includes("ai-guessed"));

  // ========================================================================
  // Summary
  // ========================================================================
  await engine.close();

  console.log("\n=== Phase 6 Regression Tests Summary ===");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(failed === 0 ? "\n🎉 All golden standard tests PASSED!" : "\n⚠️ Some tests FAILED");
  if (failed > 0) {
    throw new Error(`${failed} assertion(s) failed`);
  }
}

defineScriptSuite("regression", runRegressionTests);
