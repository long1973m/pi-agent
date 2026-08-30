/**
 * render-report 集成测试
 *
 * 验证 renderReport 生成的 HTML 包含关键元素。
 * 运行: npx tsx src/eval/render-report.test.ts
 */

import { renderReport } from "../report/render-report.js";
import { defineScriptSuite } from "./helpers/vitest-suite.js";

function run(): void {

const entries = [
  { type: "thinking_level_change", id: "t1", parentId: null, timestamp: "2026-01-01T00:00:00Z" } as any,
  { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:01:00Z", message: { role: "user", content: "帮我分析销售数据", timestamp: 0 } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:01:05Z", message: { role: "assistant", content: [{ type: "text", text: "好的" }, { type: "toolCall", id: "tc1", name: "query_data", arguments: { sql: "SELECT count(*) FROM t" } }], timestamp: 0 } },
  { type: "message", id: "tr1", parentId: "a1", timestamp: "2026-01-01T00:01:06Z", message: { role: "toolResult", toolCallId: "tc1", toolName: "query_data", content: [{ type: "text", text: "100 rows" }], isError: false, timestamp: 0 } },
];

const result = renderReport({ entries, title: "测试报告", generatedAt: "2026-01-01" });

let ok = 0;
let fail = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    ok++;
  } else {
    console.log(`  ❌ ${name}`);
    fail++;
  }
}

// HTML 结构
assert(result.html.includes("<!DOCTYPE html>"), "Has DOCTYPE");
assert(result.html.includes("测试报告"), "Contains title");
assert(result.html.includes("2026-01-01"), "Contains generatedAt");

// 消息内容
assert(result.html.includes("帮我分析销售数据"), "Contains user message");
assert(result.html.includes("好的"), "Contains assistant text");

// 工具调用卡片
assert(result.html.includes("query_data"), "Contains tool name");
assert(result.html.includes("sql-card"), "Has SQL card for query_data");
assert(result.html.includes("sql-kw"), "SQL keywords are highlighted");
assert(result.html.includes("SELECT") || result.html.includes("<span class=\"sql-kw\">SELECT</span>"), "Contains SELECT keyword");
assert(result.html.includes("100 rows"), "Contains tool result");

// 锚点导航
assert(result.html.includes("msg-0"), "Has anchor IDs");
assert(result.html.includes("Navigation"), "Has TOC section");

// 主题
assert(result.html.includes("prefers-color-scheme"), "Has light/dark theme CSS");
assert(result.html.includes("Toggle theme"), "Has theme toggle button");

// 统计
assert(result.messageCount === 2, `Message count = 2 (got ${result.messageCount})`);
assert(result.chartCount === 0, `Chart count = 0 (got ${result.chartCount})`);
assert(result.htmlSizeBytes > 0, "HTML size > 0");

// PII 脱敏（包含手机号的用户消息）
const entriesWithPII = [
  { type: "message", id: "p1", parentId: null, timestamp: "2026-01-01T00:01:00Z", message: { role: "user", content: "我的手机号是13812345678，帮我查一下", timestamp: 0 } },
  { type: "message", id: "p2", parentId: "p1", timestamp: "2026-01-01T00:01:05Z", message: { role: "assistant", content: [{ type: "text", text: "已查询到。" }], timestamp: 0 } },
];
const piiResult = renderReport({ entries: entriesWithPII, title: "PII Test", generatedAt: "2026-01-01" });
assert(!piiResult.html.includes("13812345678"), "Phone number masked in HTML");
assert(piiResult.html.includes("138****5678"), "Phone number partially visible");

if (fail > 0) {
  throw new Error(`${fail} assertion(s) failed`);
}
}

defineScriptSuite("render-report", run);
