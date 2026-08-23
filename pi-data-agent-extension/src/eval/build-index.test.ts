/**
 * Task 4 / S6.3 单元测试 — 报告索引页（含数据集标签）
 * 运行: npx tsx src/eval/build-index.test.ts
 */

import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildReportIndex } from "../report/build-index.js";

let ok = 0;
let fail = 0;

function assert(c: boolean, n: string) {
  if (c) { console.log(`  ✅ ${n}`); ok++; } else { console.log(`  ❌ ${n}`); fail++; }
}

const TEST_DIR = "/Users/mare/.trae-cn/work/6a4fa35454757aacbdfdbdfe/test-reports";

function setup() {
  try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  mkdirSync(TEST_DIR, { recursive: true });
}

function teardown() {
  try { rmSync(TEST_DIR, { recursive: true }); } catch {}
}

// Test 1: 空目录生成索引
console.log("\nTest 1: Empty directory");
{
  setup();
  const result = buildReportIndex(TEST_DIR);
  assert(result === true, "Builds index for empty dir");
  const indexPath = join(TEST_DIR, "index.html");
  assert(existsSync(indexPath), "index.html created");
  const html = readFileSync(indexPath, "utf-8");
  assert(html.includes("暂无报告"), "Shows empty message");
  teardown();
}

// Test 2: 按时间倒序排列
console.log("\nTest 2: Reverse chronological order");
{
  setup();
  writeFileSync(join(TEST_DIR, "session-1704067200000.html"), "<html><body>Old</body></html>", "utf-8");
  writeFileSync(join(TEST_DIR, "session-1704153600000.html"), "<html><body>New</body></html>", "utf-8");
  buildReportIndex(TEST_DIR);
  const html = readFileSync(join(TEST_DIR, "index.html"), "utf-8");
  const idx1 = html.indexOf("session-1704153600000");
  const idx2 = html.indexOf("session-1704067200000");
  assert(idx1 < idx2, "Newer report comes first");
  teardown();
}

// Test 3: meta summary 提取
console.log("\nTest 3: Meta summary extraction");
{
  setup();
  const report = `<html><head><meta name="summary" content="销售数据分析结果"></head><body>Report</body></html>`;
  writeFileSync(join(TEST_DIR, "session-1704067200000.html"), report, "utf-8");
  buildReportIndex(TEST_DIR);
  const html = readFileSync(join(TEST_DIR, "index.html"), "utf-8");
  assert(html.includes("销售数据分析结果"), "Extracts meta summary");
  teardown();
}

// Test 4: S6.3 — datasets meta 提取并显示标签
console.log("\nTest 4: S6.3 — Datasets meta tags");
{
  setup();
  const report = `<html><head><meta name="summary" content="销售分析"><meta name="datasets" content="sales,products"></head><body>Report</body></html>`;
  writeFileSync(join(TEST_DIR, "session-1704067200000.html"), report, "utf-8");
  buildReportIndex(TEST_DIR);
  const html = readFileSync(join(TEST_DIR, "index.html"), "utf-8");
  assert(html.includes('class="idx-tag"'), "Has dataset tag elements");
  assert(html.includes("sales"), "Tag shows 'sales'");
  assert(html.includes("products"), "Tag shows 'products'");
  teardown();
}

// Test 5: S6.3 — 无 datasets meta 时不显示标签
console.log("\nTest 5: S6.3 — No datasets when meta absent");
{
  setup();
  const report = `<html><head><meta name="summary" content="无数据集"></head><body>Report</body></html>`;
  writeFileSync(join(TEST_DIR, "session-1704067200000.html"), report, "utf-8");
  buildReportIndex(TEST_DIR);
  const html = readFileSync(join(TEST_DIR, "index.html"), "utf-8");
  assert(!html.includes('class="idx-tag"'), "No dataset tags when meta absent");
  teardown();
}

// Test 6: 非 session-*.html 文件被忽略
console.log("\nTest 6: Ignores non-session files");
{
  setup();
  writeFileSync(join(TEST_DIR, "other.html"), "<html></html>", "utf-8");
  writeFileSync(join(TEST_DIR, "session-1704067200000.html"), "<html></html>", "utf-8");
  buildReportIndex(TEST_DIR);
  const html = readFileSync(join(TEST_DIR, "index.html"), "utf-8");
  assert(!html.includes("other.html"), "Ignores non-session files");
  assert(html.includes("session-1704067200000"), "Includes session files");
  teardown();
}

// Test 7: 不存在的目录返回 false
console.log("\nTest 7: Non-existent directory");
{
  const result = buildReportIndex("/nonexistent/path/12345");
  assert(result === false, "Returns false for non-existent dir");
}

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
