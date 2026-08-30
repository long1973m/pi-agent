/**
 * S5.2 PII Guard 验收测试
 *
 * 运行: npx tsx src/eval/pii-guard.test.ts
 *
 * 覆盖:
 * - PII1: email 检测 + 替换
 * - PII2: phone 检测 + 替换
 * - PII3: id_card 检测 + 替换
 * - PII4: 混合 PII 一次性替换
 * - PII5: 无 PII 文本不改变
 * - PII6: 空值/非字符串不报错
 * - PII7: DuckDB 原始数据不改变
 * - PII8: 进入 prompt 的样本已脱敏（data-dictionary 集成）
 */

import { maskPII, detectPII, maskPIIArray } from "../pii-guard.js";
import { loadConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { DataDictionaryManager } from "../hooks/data-dictionary.js";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { defineScriptSuite } from "./helpers/vitest-suite.js";

const TEST_CWD = cwd();
const EVAL_DIR = join(TEST_CWD, ".pi-data-agent", "eval");

async function runPIITests(): Promise<void> {
  console.log("=== S5.2 PII Guard Tests ===\n");
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

  // ========================================================================
  // PII1: email 检测 + 替换
  // ========================================================================
  console.log("\n[PII1] Email detection");
  const email1 = maskPII("Contact: alice@example.com for details");
  assert("email: detected", email1.matches.length === 1);
  assert("email: type is email", email1.matches[0].type === "email");
  assert("email: masked contains ***", email1.masked.includes("***"));
  assert("email: domain preserved", email1.masked.includes("@example.com"));

  // 多个 email
  const email2 = maskPII("Send to bob@test.org and carol@company.cn");
  assert("email: multiple detected", email2.matches.length === 2);
  assert("email: both masked", email2.masked.includes("***") && !email2.masked.includes("bob@test") && !email2.masked.includes("carol@company"));

  // ========================================================================
  // PII2: phone 检测 + 替换
  // ========================================================================
  console.log("\n[PII2] Phone detection");
  const phone1 = maskPII("Phone: 13812345678");
  assert("phone: detected", phone1.matches.length === 1);
  assert("phone: type is phone", phone1.matches[0].type === "phone");
  assert("phone: masked 138****5678", phone1.masked === "Phone: 138****5678");

  // 多个 phone
  const phone2 = maskPII("13911112222 and 18633334444");
  assert("phone: multiple detected", phone2.matches.length === 2);
  assert("phone: both masked", !phone2.masked.includes("11112222") && !phone2.masked.includes("33334444"));

  // 非 1 开头不算
  const phone3 = maskPII("Number: 02112345678");
  assert("phone: non-1-start not detected", phone3.matches.length === 0);

  // ========================================================================
  // PII3: id_card 检测 + 替换
  // ========================================================================
  console.log("\n[PII3] ID card detection");
  const id1 = maskPII("ID: 110101199003077654");
  assert("id_card: detected", id1.matches.length === 1);
  assert("id_card: type is id_card", id1.matches[0].type === "id_card");
  assert("id_card: masked", id1.masked.includes("******"));
  assert("id_card: first 6 preserved", id1.masked.includes("110101"));
  assert("id_card: last 4 preserved", id1.masked.includes("7654"));

  // 带 X 结尾
  const id2 = maskPII("ID: 32010219851212678X");
  assert("id_card: X suffix detected", id2.matches.length === 1);

  // 非 18 位不算
  const id3 = maskPII("Number: 1234567890123");
  assert("id_card: non-18-digit not detected", id3.matches.length === 0);

  // ========================================================================
  // PII4: 混合 PII 一次性替换
  // ========================================================================
  console.log("\n[PII4] Mixed PII");
  const mixed = maskPII("User: 张三, email: zhang@test.com, phone: 15900001111, id: 110101199003077654");
  assert("mixed: all detected", mixed.matches.length === 3);
  assert("mixed: email masked", !mixed.masked.includes("zhang@test.com"));
  assert("mixed: phone masked", !mixed.masked.includes("15900001111"));
  assert("mixed: id_card masked", !mixed.masked.includes("19900307"));

  // ========================================================================
  // PII5: 无 PII 文本不改变
  // ========================================================================
  console.log("\n[PII5] No PII");
  const clean = maskPII("Hello world 123 45.6");
  assert("no pii: no matches", clean.matches.length === 0);
  assert("no pii: text unchanged", clean.masked === "Hello world 123 45.6");

  // ========================================================================
  // PII6: 空值/非字符串不报错
  // ========================================================================
  console.log("\n[PII6] Edge cases");
  assert("empty: returns empty", maskPII("").masked === "");
  assert("null-like: returns null-like", maskPII(null as any).masked === null);
  assert("undefined: returns undefined", maskPII(undefined as any).masked === undefined);
  assert("number-like string: no crash", maskPII("12345").masked === "12345");

  // ========================================================================
  // PII7: DuckDB 原始数据不改变
  // ========================================================================
  console.log("\n[PII7] DuckDB data unchanged");
  mkdirSync(EVAL_DIR, { recursive: true });
  const piiCsv = `name,email,phone,id_card
Alice,alice@test.com,13800001111,110101199001011234
Bob,bob@work.cn,15900002222,32010219851212678X
`;
  const piiCsvPath = join(EVAL_DIR, "pii_test.csv");
  writeFileSync(piiCsvPath, piiCsv);

  const config = loadConfig();
  const engine = new DuckDBEngine({ dbPath: config.dbPath, previewLimit: config.previewLimit, outputDir: config.outputDir });
  await engine.init();

  const loadSql = `CREATE OR REPLACE TABLE pii_test AS SELECT * FROM read_csv_auto('${piiCsvPath}')`;
  await engine.exec(loadSql);

  // 查询原始数据，应完整保留
  const result = await engine.executeQueryWithLimit("SELECT * FROM pii_test WHERE name = 'Alice'");
  const aliceRow = result.rows[0];
  assert("raw: email intact", String(aliceRow[1]) === "alice@test.com");
  assert("raw: phone intact", String(aliceRow[2]) === "13800001111");
  assert("raw: id_card intact", String(aliceRow[3]) === "110101199001011234");

  // ========================================================================
  // PII8: 进入 prompt 的样本已脱敏
  // ========================================================================
  console.log("\n[PII8] Dictionary sample values masked");
  const persistence = new PersistenceManager(config.globalConfigDir, config.projectConfigDir);
  persistence.saveDataDictionary([], "project");
  persistence.saveQueryMemory({ maxEntries: 5, entries: [] }, "project");

  const dataDict = new DataDictionaryManager(persistence);
  await dataDict.ensureDictionary("pii_test", engine);
  const dict = dataDict.getDictionary("pii_test");

  const emailCol = dict?.columns.find((c) => c.name === "email");
  const emailSv = emailCol?.sampleValues;
  assert("dict: email sample masked", emailSv ? !emailSv[0].includes("alice") && emailSv[0].includes("***") : false);

  const phoneCol = dict?.columns.find((c) => c.name === "phone");
  const phoneSv = phoneCol?.sampleValues;
  assert("dict: phone sample masked", phoneSv ? phoneSv[0] === "138****1111" : false);

  const idCol = dict?.columns.find((c) => c.name === "id_card");
  const idSv = idCol?.sampleValues;
  assert("dict: id_card sample masked", idSv ? idSv[0]?.includes("******") === true : false);

  // Cleanup
  await engine.close();
  try { unlinkSync(piiCsvPath); } catch { /* ignore */ }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    throw new Error(`${failed} assertion(s) failed`);
  }
}

defineScriptSuite("pii-guard", runPIITests);
