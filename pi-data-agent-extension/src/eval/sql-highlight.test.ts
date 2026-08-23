/**
 * Task 1 单元测试 — SQL 高亮
 * 运行: npx tsx src/eval/sql-highlight.test.ts
 */

import { highlightSql, getFirstLines, exceedsLines } from "../report/sql-highlight.js";

let ok = 0;
let fail = 0;

function assert(c: boolean, n: string) {
  if (c) { console.log(`  ✅ ${n}`); ok++; } else { console.log(`  ❌ ${n}`); fail++; }
}

// Test 1: 基本关键字高亮
console.log("\nTest 1: Basic keyword highlighting");
{
  const sql = "SELECT * FROM users WHERE id = 1";
  const html = highlightSql(sql);
  assert(html.includes('<span class="sql-kw">SELECT</span>'), "SELECT is keyword");
  assert(html.includes('<span class="sql-kw">FROM</span>'), "FROM is keyword");
  assert(html.includes('<span class="sql-kw">WHERE</span>'), "WHERE is keyword");
  assert(!html.includes("SELECT *"), "Raw SELECT not in output (it's wrapped)");
}

// Test 2: 字符串高亮
console.log("\nTest 2: String highlighting");
{
  const sql = "SELECT * FROM t WHERE name = 'Alice'";
  const html = highlightSql(sql);
  assert(html.includes('<span class="sql-str">\'Alice\'</span>'), "Single-quoted string highlighted");
}

// Test 3: 数字高亮
console.log("\nTest 3: Number highlighting");
{
  const sql = "SELECT * FROM t WHERE id = 42 AND amount = 3.14";
  const html = highlightSql(sql);
  assert(html.includes('<span class="sql-num">42</span>'), "Integer highlighted");
  assert(html.includes('<span class="sql-num">3.14</span>'), "Float highlighted");
}

// Test 4: 注释高亮
console.log("\nTest 4: Comment highlighting");
{
  const sql = "SELECT 1 -- this is a comment\nFROM t";
  const html = highlightSql(sql);
  assert(html.includes('<span class="sql-cmt">-- this is a comment</span>'), "Line comment highlighted");
}

// Test 5: 块注释
console.log("\nTest 5: Block comment");
{
  const sql = "SELECT /* block */ 1 FROM t";
  const html = highlightSql(sql);
  assert(html.includes('<span class="sql-cmt">/* block */</span>'), "Block comment highlighted");
}

// Test 6: 大小写不敏感的关键字
console.log("\nTest 6: Case-insensitive keywords");
{
  const sql = "select * from t where x = 1";
  const html = highlightSql(sql);
  assert(html.includes('<span class="sql-kw">select</span>'), "Lowercase select highlighted");
  assert(html.includes('<span class="sql-kw">from</span>'), "Lowercase from highlighted");
}

// Test 7: 标识符高亮
console.log("\nTest 7: Identifier highlighting");
{
  const sql = "SELECT user_name, email FROM users";
  const html = highlightSql(sql);
  assert(html.includes('<span class="sql-id">user_name</span>'), "Identifier highlighted");
}

// Test 8: 操作符高亮
console.log("\nTest 8: Operator highlighting");
{
  const sql = "SELECT * FROM t WHERE a >= 1 AND b <= 2 AND c != 3";
  const html = highlightSql(sql);
  assert(html.includes('<span class="sql-op">&gt;=</span>'), ">= operator highlighted (HTML escaped)");
  assert(html.includes('<span class="sql-op">&lt;=</span>'), "<= operator highlighted (HTML escaped)");
  assert(html.includes('<span class="sql-op">!=</span>'), "!= operator highlighted");
}

// Test 9: getFirstLines
console.log("\nTest 9: getFirstLines");
{
  const sql = "SELECT 1\nFROM t\nWHERE x = 1\nORDER BY y";
  assert(getFirstLines(sql, 3) === "SELECT 1\nFROM t\nWHERE x = 1", "First 3 lines correct");
  assert(getFirstLines(sql, 10) === sql, "N > total lines returns all");
  assert(getFirstLines("", 3) === "", "Empty string returns empty");
}

// Test 10: exceedsLines
console.log("\nTest 10: exceedsLines");
{
  assert(exceedsLines("SELECT 1\nFROM t\nWHERE x = 1", 2) === true, "3 lines > 2 threshold");
  assert(exceedsLines("SELECT 1\nFROM t", 3) === false, "2 lines <= 3 threshold");
  assert(exceedsLines("SELECT 1", 3) === false, "1 line <= 3 threshold");
}

// Test 11: 复杂 SQL
console.log("\nTest 11: Complex SQL");
{
  const sql = `SELECT u.id, u.name, COUNT(o.id) as order_count
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.created_at >= '2024-01-01'
GROUP BY u.id, u.name
HAVING COUNT(o.id) > 5
ORDER BY order_count DESC
LIMIT 10`;
  const html = highlightSql(sql);
  assert(html.includes('<span class="sql-kw">SELECT</span>'), "SELECT in complex SQL");
  assert(html.includes('<span class="sql-kw">LEFT</span>'), "LEFT JOIN keyword");
  assert(html.includes('<span class="sql-kw">JOIN</span>'), "JOIN keyword");
  assert(html.includes('<span class="sql-kw">GROUP</span>'), "GROUP BY keyword");
  assert(html.includes('<span class="sql-kw">HAVING</span>'), "HAVING keyword");
  assert(html.includes('<span class="sql-kw">LIMIT</span>'), "LIMIT keyword");
  assert(html.includes('<span class="sql-str">\'2024-01-01\'</span>'), "Date string highlighted");
}

// Test 12: CTE (WITH ... AS)
console.log("\nTest 12: CTE");
{
  const sql = `WITH monthly_sales AS (
  SELECT date_trunc('month', order_date) AS month, SUM(amount) AS total
  FROM orders
  GROUP BY 1
)
SELECT * FROM monthly_sales WHERE total > 1000`;
  const html = highlightSql(sql);
  assert(html.includes('<span class="sql-kw">WITH</span>'), "WITH keyword");
  assert(html.includes('<span class="sql-kw">AS</span>'), "AS keyword");
  assert(html.includes('<span class="sql-id">monthly_sales</span>'), "CTE name as identifier");
  assert(html.includes('<span class="sql-kw">GROUP</span>'), "GROUP BY in CTE body");
}

// Test 13: 子查询
console.log("\nTest 13: Subquery");
{
  const sql = "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders WHERE amount > 100)";
  const html = highlightSql(sql);
  assert(html.includes('<span class="sql-kw">IN</span>'), "IN keyword");
  // 子查询内部的 SELECT 也应该被高亮
  const selectCount = (html.match(/sql-kw/g) || []).length;
  assert(selectCount >= 3, `At least 3 keywords highlighted (got ${selectCount}) — both SELECTs and FROM`);
}

// Test 14: UNION
console.log("\nTest 14: UNION");
{
  const sql = `SELECT name, 'customer' AS type FROM customers
UNION ALL
SELECT name, 'supplier' AS type FROM suppliers`;
  const html = highlightSql(sql);
  assert(html.includes('<span class="sql-kw">UNION</span>'), "UNION keyword");
  assert(html.includes('<span class="sql-kw">ALL</span>'), "ALL keyword");
}

// Test 15: 嵌套括号不崩溃
console.log("\nTest 15: Nested parentheses");
{
  const sql = "SELECT COALESCE((SELECT MAX(x) FROM t WHERE y = 1), 0) AS val";
  const html = highlightSql(sql);
  assert(html.includes('<span class="sql-kw">COALESCE</span>'), "COALESCE highlighted");
  assert(html.includes('<span class="sql-kw">SELECT</span>'), "Nested SELECT highlighted");
  assert(html.includes('<span class="sql-kw">MAX</span>'), "MAX highlighted");
}

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);