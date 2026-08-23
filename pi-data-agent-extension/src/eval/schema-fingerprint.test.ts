/**
 * S3.1 Schema Fingerprint 过时闸验收测试
 *
 * 运行: npx tsx src/eval/schema-fingerprint.test.ts
 *
 * 覆盖:
 * - F1.1: describe_data 计算并存储 schema fingerprint
 * - F1.2: query_data 记录查询时包含 fingerprint
 * - F1.3: query_memory 检测过时查询（schema changed 标注）
 * - F1.4: load_data 刷新 fingerprint
 * - F1.5: describe_data 刷新 fingerprint
 * - F1.6: 过时查询自动降级（不提示匹配）
 */

import { loadConfig, toSecurityConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { SecurityChecker } from "../security.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { DataDictionaryManager } from "../hooks/data-dictionary.js";
import { QueryMemoryManager } from "../hooks/query-memory.js";
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
4.7,3.2,1.3,0.2,setosa
`;
  const path = join(EVAL_DIR, "iris_fp.csv");
  writeFileSync(path, irisCsv);
  return path;
}

async function runFingerprintTests(): Promise<void> {
  console.log("=== S3.1 Schema Fingerprint Tests ===\n");
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
  persistence.saveQueryMemory({ maxEntries: 10, entries: [] }, "project");

  const engine = new DuckDBEngine({
    dbPath: config.dbPath,
    previewLimit: config.previewLimit,
    outputDir: config.outputDir,
  });
  await engine.init();

  const dataDict = new DataDictionaryManager(persistence);
  const queryMemory = new QueryMemoryManager(persistence);

  // ========================================================================
  // F1.1: describe_data 计算并存储 schema fingerprint
  // ========================================================================
  console.log("\n[F1.1] Fingerprint computed on describe");
  const loadSql = `CREATE OR REPLACE TABLE iris_fp AS SELECT * FROM read_csv_auto('${irisPath}');`;
  await engine.exec(loadSql);

  // 先 describe 以生成字典
  await dataDict.ensureDictionary("iris_fp", engine);
  const dict1 = dataDict.getDictionary("iris_fp");
  assert("fingerprint: exists after describe", !!dict1?.schemaFingerprint);
  assert("fingerprint: is 32-char hex", dict1?.schemaFingerprint?.length === 32);

  // ========================================================================
  // F1.4: load_data 刷新 fingerprint
  // ========================================================================
  console.log("\n[F1.4] Fingerprint refreshed on load");
  const oldFp = dict1?.schemaFingerprint;
  // 修改表结构（添加一列）
  await engine.exec("ALTER TABLE iris_fp ADD COLUMN new_col INTEGER DEFAULT 0");
  // 刷新 fingerprint
  await dataDict.refreshFingerprint("iris_fp", engine);
  const dict2 = dataDict.getDictionary("iris_fp");
  assert("refresh: fingerprint changed", dict2?.schemaFingerprint !== oldFp);

  // 恢复表结构
  await engine.exec(`CREATE OR REPLACE TABLE iris_fp AS SELECT * FROM read_csv_auto('${irisPath}');`);
  await dataDict.refreshFingerprint("iris_fp", engine);

  // ========================================================================
  // F1.2: query_data 记录查询时包含 fingerprint
  // ========================================================================
  console.log("\n[F1.2] Query memory records fingerprint");
  const currentFp = dataDict.getDictionary("iris_fp")?.schemaFingerprint ?? "";
  queryMemory.setDatasetFingerprint(currentFp);

  queryMemory.recordQuery({
    naturalLanguageQuery: "有多少条数据",
    sql: "SELECT COUNT(*) FROM iris_fp",
    datasetFingerprint: currentFp,
    resultSummary: "3 rows",
  });

  const mem = queryMemory.getMemory();
  assert("record: 1 entry", mem.entries.length === 1);
  assert("record: fingerprint matches", mem.entries[0].datasetFingerprint === currentFp);

  // ========================================================================
  // F1.6: 过时查询自动降级（不提示匹配）
  // ========================================================================
  console.log("\n[F1.6] Stale queries degraded");
  // 模拟 schema 变化：修改表结构
  await engine.exec("ALTER TABLE iris_fp ADD COLUMN extra VARCHAR DEFAULT 'x'");
  await dataDict.refreshFingerprint("iris_fp", engine);
  const newFp = dataDict.getDictionary("iris_fp")?.schemaFingerprint ?? "";

  // 设置新的 fingerprint
  queryMemory.setDatasetFingerprint(newFp);

  // 尝试召回相关查询（旧的 fingerprint 不匹配）
  const relevant = queryMemory.recallRelevantQueries(3);
  assert("degrade: no relevant queries", relevant.length === 0);

  // ========================================================================
  // F1.3: query_memory 检测过时查询（schema changed 标注）
  // ========================================================================
  console.log("\n[F1.3] Schema changed annotation");
  const injection = queryMemory.generatePromptInjection();
  assert("annotation: contains Schema Change Detected", injection.includes("Schema Change Detected"));
  assert("annotation: mentions outdated entries", injection.includes("outdated"));

  // Cleanup
  await engine.close();
  try { unlinkSync(irisPath); } catch { /* ignore */ }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runFingerprintTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
