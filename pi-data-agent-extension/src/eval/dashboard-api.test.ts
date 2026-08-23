/**
 * Dashboard API 测试
 * 覆盖 D1, D2, D10, D11
 *
 * D1: 报告列表 - 空目录返回空列表、损坏报告不影响其他
 * D2: 报告内容 - 返回报告 HTML
 * D10: 图表索引 - manifest 格式和 legacy HTML 格式都能识别
 * D11: SQL 历史 - 三种状态（active/outdated/failed）可筛选和排序
 *
 * 运行: npx tsx src/eval/dashboard-api.test.ts
 */

import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ReportIndexService } from "../dashboard/services/report-index.js";
import { ChartIndexService } from "../dashboard/services/chart-index.js";
import { QueryMemoryReader } from "../dashboard/services/query-memory-reader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".tmp-dashboard-api-test");

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${message}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual === expected) {
    console.log(`  [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

function setup() {
  try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "reports"), { recursive: true });
}

function teardown() {
  try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
}

// ============================================================================
// D1: 报告列表
// ============================================================================

console.log("\n--- D1: 报告列表 ---");

// D1-a: 空目录返回空列表
console.log("\nD1-a: 空目录返回空列表");
{
  setup();
  const svc = new ReportIndexService(TEST_DIR);
  const result = svc.list({});
  assertEqual(result.total, 0, "空目录返回 0 条报告");
  assertEqual(result.items.length, 0, "空目录返回空 items 数组");
  assertEqual(result.page, 1, "默认 page=1");
  assertEqual(result.totalPages, 1, "空列表 totalPages=1");
  teardown();
}

// D1-b: 损坏报告不影响其他
console.log("\nD1-b: 损坏报告不影响其他报告");
{
  setup();
  const reportsDir = join(TEST_DIR, "reports");
  // 正常报告
  writeFileSync(join(reportsDir, "session-1704153600000.html"),
    `<html><head><title>正常报告</title><meta name="summary" content="一份正常报告"><meta name="generated-at" content="2026-01-02T00:00:00Z"></head><body>OK</body></html>`,
    "utf-8",
  );
  // 损坏报告（非法 UTF-8 / 截断的 HTML）
  writeFileSync(join(reportsDir, "session-1704067200000.html"), "<<<BROKEN", "utf-8");

  const svc = new ReportIndexService(TEST_DIR);
  const result = svc.list({});
  assertEqual(result.total, 2, "损坏报告不丢失，仍返回 2 条");
  // 正常报告应可获取详情
  const normal = svc.get("session-1704153600000");
  assert(normal !== null, "正常报告可 get 到");
  assertEqual(normal!.title, "正常报告", "正常报告标题正确");
  teardown();
}

// ============================================================================
// D2: 报告内容
// ============================================================================

console.log("\n--- D2: 报告内容 ---");

console.log("\nD2-a: 返回报告 HTML 内容");
{
  setup();
  const reportsDir = join(TEST_DIR, "reports");
  const htmlContent = "<html><head><title>Test</title></head><body>Hello World</body></html>";
  writeFileSync(join(reportsDir, "session-1704153600000.html"), htmlContent, "utf-8");

  const svc = new ReportIndexService(TEST_DIR);
  const content = svc.getContent("session-1704153600000");
  assert(content !== null, "getContent 返回非 null");
  assertEqual(content, htmlContent, "getContent 返回完整 HTML");
  teardown();
}

console.log("\nD2-b: 不存在的报告返回 null");
{
  setup();
  const svc = new ReportIndexService(TEST_DIR);
  const content = svc.getContent("nonexistent-report");
  assertEqual(content, null, "不存在的报告返回 null");
  teardown();
}

// ============================================================================
// D10: 图表索引
// ============================================================================

console.log("\n--- D10: 图表索引 ---");

// D10-a: manifest 格式识别图表
console.log("\nD10-a: manifest.json 格式识别图表");
{
  setup();
  const reportsDir = join(TEST_DIR, "reports");
  const manifest = {
    revision: 1,
    reports: [
      {
        id: "r1",
        title: "销售报告",
        summary: "月度销售分析",
        createdAt: "2026-01-15T00:00:00Z",
        file: "session-r1.html",
        datasets: ["sales"],
        charts: [
          { id: "c1", title: "月度销售额趋势", generatedAt: "2026-01-15T00:00:00Z", dataset: "sales", sourceReportId: "r1", sourceReportFile: "session-r1.html" },
          { id: "c2", title: "品类占比", generatedAt: "2026-01-15T00:01:00Z", dataset: "sales", sourceReportId: "r1", sourceReportFile: "session-r1.html" },
        ],
      },
    ],
  };
  writeFileSync(join(reportsDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

  const svc = new ChartIndexService(TEST_DIR);
  const result = svc.list({});
  assertEqual(result.total, 2, "manifest 识别出 2 个图表");
  // 图表按 generatedAt 倒序：c2 (00:01) > c1 (00:00)
  assertEqual(result.items[0].id, "c2", "第一个图表 ID 正确（倒序）");
  assertEqual(result.items[1].id, "c1", "第二个图表 ID 正确（倒序）");
  assertEqual(result.items[0].dataset, "sales", "图表关联数据集正确");
  teardown();
}

// D10-b: legacy HTML 格式识别图表（base64 图片）
console.log("\nD10-b: legacy HTML 格式识别图表");
{
  setup();
  const reportsDir = join(TEST_DIR, "reports");
  // 生成一个超 500 字符的 base64 图片来确保能被识别
  const base64Data = "iVBORw0KGgoAAAANSUhEUg" + "A".repeat(500);
  const legacyHtml = `<html><head><meta name="datasets" content="orders"><meta name="generated-at" content="2026-02-01T00:00:00Z"></head><body>
    <img src="data:image/png;base64,${base64Data}" alt="订单量趋势图">
  </body></html>`;
  writeFileSync(join(reportsDir, "session-1738368000000.html"), legacyHtml, "utf-8");

  const svc = new ChartIndexService(TEST_DIR);
  const result = svc.list({});
  assertEqual(result.total, 1, "legacy 格式识别出 1 个图表");
  assertEqual(result.items[0].sourceReportId, "session-1738368000000", "图表关联正确的报告 ID");
  assertEqual(result.items[0].dataset, "orders", "图表关联正确的数据集");
  teardown();
}

// D10-c: 按 reportId 和 dataset 筛选
console.log("\nD10-c: 图表筛选功能");
{
  setup();
  const reportsDir = join(TEST_DIR, "reports");
  const manifest = {
    revision: 1,
    reports: [
      {
        id: "r1", title: "T1", summary: "s", createdAt: "2026-01-01T00:00:00Z", file: "f1.html", datasets: ["sales"],
        charts: [{ id: "c1", title: "Chart1", generatedAt: "2026-01-01T00:00:00Z", dataset: "sales", sourceReportId: "r1", sourceReportFile: "f1.html" }],
      },
      {
        id: "r2", title: "T2", summary: "s", createdAt: "2026-01-02T00:00:00Z", file: "f2.html", datasets: ["users"],
        charts: [{ id: "c2", title: "Chart2", generatedAt: "2026-01-02T00:00:00Z", dataset: "users", sourceReportId: "r2", sourceReportFile: "f2.html" }],
      },
    ],
  };
  writeFileSync(join(reportsDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

  const svc = new ChartIndexService(TEST_DIR);

  const byReport = svc.list({ reportId: "r1" });
  assertEqual(byReport.total, 1, "按 reportId 筛选返回 1 个图表");
  assertEqual(byReport.items[0].id, "c1", "筛选结果 ID 正确");

  const byDataset = svc.list({ dataset: "users" });
  assertEqual(byDataset.total, 1, "按 dataset 筛选返回 1 个图表");
  assertEqual(byDataset.items[0].id, "c2", "筛选结果 ID 正确");
  teardown();
}

// ============================================================================
// D11: SQL 历史
// ============================================================================

console.log("\n--- D11: SQL 历史 ---");

// 构造 mock query-memory.json
function writeQueryMemory(entries: Array<{
  id: string;
  naturalLanguageQuery: string;
  sql: string;
  datasetFingerprint: string;
  timestamp: string;
  useCount: number;
  success: boolean;
  resultSummary?: string;
}>) {
  const path = join(TEST_DIR, "query-memory.json");
  writeFileSync(path, JSON.stringify({ entries }, null, 2), "utf-8");
}

// D11-a: 三种状态判定（无 engine 时指纹为 null，全部 active 或 failed）
console.log("\nD11-a: 状态判定 — failed 条目标记为 failed");
{
  setup();
  writeQueryMemory([
    { id: "q1", naturalLanguageQuery: "销售总额", sql: "SELECT SUM(amount) FROM orders", datasetFingerprint: "fp1", timestamp: "2026-01-10T00:00:00Z", useCount: 5, success: true, resultSummary: "1000" },
    { id: "q2", naturalLanguageQuery: "无效查询", sql: "SELECTT * FROM nonexistent", datasetFingerprint: "fp1", timestamp: "2026-01-11T00:00:00Z", useCount: 0, success: false },
    { id: "q3", naturalLanguageQuery: "用户数", sql: "SELECT COUNT(*) FROM users", datasetFingerprint: "fp1", timestamp: "2026-01-12T00:00:00Z", useCount: 3, success: true, resultSummary: "200" },
  ]);

  // 不传 engine → fingerprint 为 null → 非 failed 的全部为 active
  const reader = new QueryMemoryReader(TEST_DIR, null);
  const result = await reader.list({});
  assertEqual(result.total, 3, "总共 3 条记录");

  const failed = result.items.find((e) => e.id === "q2");
  assert(failed !== undefined, "q2 存在于结果中");
  assertEqual(failed!.status, "failed", "失败的查询状态为 failed");

  const active = result.items.find((e) => e.id === "q1");
  assertEqual(active!.status, "active", "成功的查询（无 engine）状态为 active");
  teardown();
}

// D11-b: 状态筛选
console.log("\nD11-b: 按状态筛选");
{
  setup();
  writeQueryMemory([
    { id: "q1", naturalLanguageQuery: "查询A", sql: "SELECT 1", datasetFingerprint: "fp1", timestamp: "2026-01-10T00:00:00Z", useCount: 1, success: true },
    { id: "q2", naturalLanguageQuery: "查询B", sql: "SELECTT", datasetFingerprint: "fp1", timestamp: "2026-01-11T00:00:00Z", useCount: 0, success: false },
  ]);

  const reader = new QueryMemoryReader(TEST_DIR, null);

  const failedOnly = await reader.list({ status: "failed" });
  assertEqual(failedOnly.total, 1, "failed 筛选返回 1 条");
  assertEqual(failedOnly.items[0].id, "q2", "failed 筛选结果正确");

  const activeOnly = await reader.list({ status: "active" });
  assertEqual(activeOnly.total, 1, "active 筛选返回 1 条");
  assertEqual(activeOnly.items[0].id, "q1", "active 筛选结果正确");

  const outdatedOnly = await reader.list({ status: "outdated" });
  assertEqual(outdatedOnly.total, 0, "outdated 筛选返回 0 条（无 engine 无法判定 outdated）");
  teardown();
}

// D11-c: 排序 — recent vs useCount
console.log("\nD11-c: 排序功能");
{
  setup();
  writeQueryMemory([
    { id: "q1", naturalLanguageQuery: "高频查询", sql: "SELECT 1", datasetFingerprint: "fp1", timestamp: "2026-01-01T00:00:00Z", useCount: 10, success: true },
    { id: "q2", naturalLanguageQuery: "低频查询", sql: "SELECT 2", datasetFingerprint: "fp1", timestamp: "2026-01-10T00:00:00Z", useCount: 1, success: true },
    { id: "q3", naturalLanguageQuery: "中频查询", sql: "SELECT 3", datasetFingerprint: "fp1", timestamp: "2026-01-05T00:00:00Z", useCount: 5, success: true },
  ]);

  const reader = new QueryMemoryReader(TEST_DIR, null);

  const byRecent = await reader.list({ sort: "recent" });
  assertEqual(byRecent.items[0].id, "q2", "recent 排序：最新时间排在前面");

  const byUseCount = await reader.list({ sort: "useCount" });
  assertEqual(byUseCount.items[0].id, "q1", "useCount 排序：高频查询排在前面");
  assertEqual(byUseCount.items[1].id, "q3", "useCount 排序：中频查询排第二");
  teardown();
}

// D11-d: 文本搜索
console.log("\nD11-d: 文本搜索");
{
  setup();
  writeQueryMemory([
    { id: "q1", naturalLanguageQuery: "月度销售额统计", sql: "SELECT SUM(amount) FROM orders", datasetFingerprint: "fp1", timestamp: "2026-01-10T00:00:00Z", useCount: 1, success: true },
    { id: "q2", naturalLanguageQuery: "用户注册趋势", sql: "SELECT COUNT(*) FROM users", datasetFingerprint: "fp1", timestamp: "2026-01-11T00:00:00Z", useCount: 2, success: true },
  ]);

  const reader = new QueryMemoryReader(TEST_DIR, null);
  const result = await reader.list({ query: "销售额" });
  assertEqual(result.total, 1, "搜索 '销售额' 返回 1 条");
  assertEqual(result.items[0].id, "q1", "搜索结果正确");
  teardown();
}

// D11-e: 分页
console.log("\nD11-e: 分页");
{
  setup();
  const entries = Array.from({ length: 5 }, (_, i) => ({
    id: `q${i + 1}`,
    naturalLanguageQuery: `查询${i + 1}`,
    sql: `SELECT ${i + 1}`,
    datasetFingerprint: "fp1",
    timestamp: `2026-01-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
    useCount: i + 1,
    success: true,
  }));
  writeQueryMemory(entries);

  const reader = new QueryMemoryReader(TEST_DIR, null);
  const page1 = await reader.list({ page: 1, size: 2 });
  assertEqual(page1.items.length, 2, "第 1 页 2 条");
  assertEqual(page1.total, 5, "总共 5 条");
  assertEqual(page1.totalPages, 3, "共 3 页");

  const page3 = await reader.list({ page: 3, size: 2 });
  assertEqual(page3.items.length, 1, "第 3 页 1 条");
  teardown();
}

// ============================================================================
// 汇总
// ============================================================================

console.log(`\n=== dashboard-api.test.ts: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);