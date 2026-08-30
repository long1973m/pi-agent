/**
 * Task 6 集成测试 — Should Have 功能
 * 运行: npx tsx src/eval/task6-should-have.test.ts
 */

import { renderReport } from "../report/render-report.js";
import type { DataDictionaryEntry } from "../types.js";
import { defineScriptSuite } from "./helpers/vitest-suite.js";

function run(): void {

let ok = 0;
let fail = 0;

function assert(c: boolean, n: string) {
  if (c) { console.log(`  ✅ ${n}`); ok++; } else { console.log(`  ❌ ${n}`); fail++; }
}

const dict: DataDictionaryEntry[] = [
  {
    tableName: "sales",
    generatedAt: "2026-01-01",
    status: "validated",
    columns: [{ name: "amount", type: "DECIMAL", inferredMeaning: "金额", status: "user-confirmed" }],
  },
  {
    tableName: "products",
    generatedAt: "2026-01-01",
    status: "validated",
    columns: [{ name: "name", type: "VARCHAR", inferredMeaning: "名称", status: "ai-guessed" }],
  },
  {
    tableName: "users",
    generatedAt: "2026-01-01",
    status: "validated",
    columns: [{ name: "id", type: "INTEGER", inferredMeaning: "ID", status: "user-confirmed" }],
  },
];

const entries = [
  { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:01:00Z", message: { role: "user", content: "分析销售数据", timestamp: 0 } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:01:05Z", message: { role: "assistant", content: [{ type: "text", text: "好的" }, { type: "toolCall", id: "tc1", name: "query_data", arguments: { sql: "SELECT * FROM sales JOIN products ON sales.product_id = products.id", user_intent: "分析销售数据" } }], timestamp: 0 } },
  { type: "message", id: "tr1", parentId: "a1", timestamp: "2026-01-01T00:01:06Z", message: { role: "toolResult", toolCallId: "tc1", toolName: "query_data", content: [{ type: "text", text: "10 rows" }], isError: false, timestamp: 0 } },
];

// Test 1: 字典只显示用过的表
console.log("\nTest 1: Dictionary filtered to used tables only");
{
  const result = renderReport({ entries, title: "Test", generatedAt: "2026-01-01", dictionaryEntries: dict });
  assert(result.html.includes("sales"), "Contains sales dictionary");
  assert(result.html.includes("products"), "Contains products dictionary");
  assert(!result.html.includes("users"), "Does NOT contain users dictionary (not used in session)");
}

// Test 2: SQL 复制按钮存在
console.log("\nTest 2: SQL copy button");
{
  const result = renderReport({ entries, title: "Test", generatedAt: "2026-01-01" });
  assert(result.html.includes('class="sql-copy-btn"'), "Has SQL copy button");
  assert(result.html.includes('data-sql='), "Copy button has data-sql attribute");
  assert(result.html.includes('复制 SQL'), "Copy button has title");
}

// Test 3: 数据来源标签
console.log("\nTest 3: Data source label on tool card");
{
  const result = renderReport({ entries, title: "Test", generatedAt: "2026-01-01" });
  assert(result.html.includes('class="tool-data-source"'), "Has data source label");
  assert(result.html.includes("sales"), "Data source shows 'sales'");
}

// Test 4: 无 SQL 时不显示复制按钮
console.log("\nTest 4: No copy button for non-query tools");
{
  const entriesNoSql = [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:01:00Z", message: { role: "user", content: "Hello", timestamp: 0 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:01:05Z", message: { role: "assistant", content: [{ type: "text", text: "Hi" }, { type: "toolCall", id: "tc1", name: "describe_data", arguments: { dataset: "sales" } }], timestamp: 0 } },
  ];
  const result = renderReport({ entries: entriesNoSql, title: "Test", generatedAt: "2026-01-01" });
  assert(!result.html.includes('class="sql-copy-btn"'), "No copy button for describe_data");
}

// Test 5: 无字典时不崩溃
console.log("\nTest 5: No dictionary provided");
{
  const result = renderReport({ entries, title: "Test", generatedAt: "2026-01-01" });
  assert(!result.html.includes('class="dict-panel"'), "No dictionary panel when none provided");
}

if (fail > 0) {
  throw new Error(`${fail} assertion(s) failed`);
}
}

defineScriptSuite("task6-should-have", run);
