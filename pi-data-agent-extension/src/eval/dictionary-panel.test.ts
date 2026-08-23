/**
 * Task 3 / S6.1 单元测试 — 数据字典面板（含筛选按钮）
 * 运行: npx tsx src/eval/dictionary-panel.test.ts
 */

import { renderDictionaryPanel } from "../report/dictionary-panel.js";
import type { DataDictionaryEntry } from "../types.js";

let ok = 0;
let fail = 0;

function assert(c: boolean, n: string) {
  if (c) { console.log(`  ✅ ${n}`); ok++; } else { console.log(`  ❌ ${n}`); fail++; }
}

const mockDict: DataDictionaryEntry[] = [
  {
    tableName: "sales",
    generatedAt: "2026-01-01",
    status: "validated",
    validatedBy: "user",
    columns: [
      { name: "date", type: "DATE", inferredMeaning: "交易日期", status: "user-confirmed" },
      { name: "amount", type: "DECIMAL", inferredMeaning: "金额", status: "user-corrected", userMeaning: "销售额（元）" },
      { name: "region", type: "VARCHAR", inferredMeaning: "地区", status: "ai-guessed" },
      { name: "notes", type: "JSON", inferredMeaning: "备注", status: "uncertain" },
    ],
  },
  {
    tableName: "products",
    generatedAt: "2026-01-01",
    status: "validated",
    columns: [
      { name: "id", type: "INTEGER", inferredMeaning: "ID", status: "user-confirmed" },
      { name: "name", type: "VARCHAR", inferredMeaning: "名称", status: "ai-guessed" },
    ],
  },
];

// Test 1: 空数组返回空字符串
console.log("\nTest 1: Empty array returns empty string");
{
  const html = renderDictionaryPanel([]);
  assert(html === "", "Empty array returns empty string");
}

// Test 2: 包含面板结构
console.log("\nTest 2: Panel structure");
{
  const html = renderDictionaryPanel(mockDict);
  assert(html.includes('<details class="dict-panel">'), "Has details wrapper");
  assert(html.includes('<summary class="dict-summary">'), "Has summary");
  assert(html.includes("2 个数据集"), "Shows dataset count");
}

// Test 3: S6.1 — 筛选控件存在
console.log("\nTest 3: S6.1 — Filter controls");
{
  const html = renderDictionaryPanel(mockDict);
  assert(html.includes('class="dict-filter-input"'), "Has text search input");
  assert(html.includes('class="dict-filter-status"'), "Has status dropdown");
  assert(html.includes('placeholder="搜索字段名..."'), "Input has placeholder");
  assert(html.includes('<option value="all">全部状态</option>'), "Dropdown has 'all' option");
  assert(html.includes('<option value="user-confirmed">已确认</option>'), "Dropdown has confirmed option");
}

// Test 4: S6.1 — 行有 data 属性用于筛选
console.log("\nTest 4: S6.1 — Row data attributes for filtering");
{
  const html = renderDictionaryPanel(mockDict);
  assert(html.includes('data-status="user-confirmed"'), "Row has status data attribute");
  assert(html.includes('data-name="date"'), "Row has name data attribute");
  assert(html.includes('data-table="sales"'), "Tbody has table data attribute");
}

// Test 5: S6.1 — 筛选脚本存在
console.log("\nTest 5: S6.1 — Filter script inline");
{
  const html = renderDictionaryPanel(mockDict);
  assert(html.includes('function applyFilter'), "Has applyFilter function");
  assert(html.includes("dict-filter-input"), "Script references input");
  assert(html.includes("dict-filter-status"), "Script references dropdown");
}

// Test 6: 表名正确
console.log("\nTest 6: Table names");
{
  const html = renderDictionaryPanel(mockDict);
  assert(html.includes("sales"), "Contains sales table");
  assert(html.includes("products"), "Contains products table");
}

// Test 7: 状态标签
console.log("\nTest 7: Status badges");
{
  const html = renderDictionaryPanel(mockDict);
  assert(html.includes("已确认"), "Has 'user-confirmed' label");
  assert(html.includes("已修正"), "Has 'user-corrected' label");
  assert(html.includes("AI推断"), "Has 'ai-guessed' label");
  assert(html.includes("不确定"), "Has 'uncertain' label");
}

// Test 8: 状态 CSS class
console.log("\nTest 8: Status CSS classes");
{
  const html = renderDictionaryPanel(mockDict);
  assert(html.includes("badge-confirmed"), "Has confirmed badge class");
  assert(html.includes("badge-corrected"), "Has corrected badge class");
  assert(html.includes("badge-guessed"), "Has guessed badge class");
  assert(html.includes("badge-uncertain"), "Has uncertain badge class");
}

// Test 9: userMeaning 优先于 inferredMeaning
console.log("\nTest 9: userMeaning precedence");
{
  const html = renderDictionaryPanel(mockDict);
  assert(html.includes("销售额（元）"), "Shows userMeaning for amount column");
}

// Test 10: HTML 转义
console.log("\nTest 10: HTML escaping");
{
  const dictWithSpecialChars: DataDictionaryEntry[] = [{
    tableName: "test<table>",
    generatedAt: "2026-01-01",
    status: "unknown",
    columns: [
      { name: "col<1>", type: "VARCHAR", inferredMeaning: "<script>", status: "ai-guessed" },
    ],
  }];
  const html = renderDictionaryPanel(dictWithSpecialChars);
  assert(!html.includes("<table>"), "Table name is escaped");
  assert(html.includes("&lt;script&gt;"), "Shows escaped script tag in meaning");
  assert(html.includes("&lt;table&gt;"), "Shows escaped table name");
}

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
