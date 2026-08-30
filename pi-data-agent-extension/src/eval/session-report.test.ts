/**
 * Task 1 单元测试 — session-transcript
 *
 * Mock SessionManager 返回预设 entries，验证 getSessionTranscript 输出。
 * 运行: npx tsx src/eval/session-report.test.ts
 */

import { getSessionTranscript, mergeToolResults, type TranscriptMessage } from "../report/session-transcript.js";
import { defineScriptSuite } from "./helpers/vitest-suite.js";

function run(): void {

// ============================================================================
// Mock 数据
// ============================================================================

const MOCK_ENTRIES = [
  // 非消息类型 — 应被过滤
  { type: "thinking_level_change", id: "t1", parentId: null, timestamp: "2026-01-01T00:00:00Z", thinkingLevel: "high" },
  { type: "model_change", id: "m1", parentId: "t1", timestamp: "2026-01-01T00:00:01Z", provider: "anthropic", modelId: "claude-sonnet-4-5" },
  { type: "compaction", id: "c1", parentId: "m1", timestamp: "2026-01-01T00:00:02Z", summary: "Earlier context...", firstKeptEntryId: "u1", tokensBefore: 10000 },

  // 用户消息
  {
    type: "message", id: "u1", parentId: "c1", timestamp: "2026-01-01T00:01:00Z",
    message: { role: "user", content: "帮我分析一下销售数据", timestamp: 1704067260000 },
  },

  // 助手消息（含工具调用）
  {
    type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:01:05Z",
    message: {
      role: "assistant", content: [
        { type: "text", text: "我来帮你查询销售数据。" },
        {
          type: "toolCall", id: "tc_001", name: "query_data",
          arguments: { sql: "SELECT * FROM sales LIMIT 10", user_intent: "查看销售数据" },
        },
      ], timestamp: 1704067265000,
    },
  },

  // 工具结果
  {
    type: "message", id: "tr1", parentId: "a1", timestamp: "2026-01-01T00:01:06Z",
    message: {
      role: "toolResult", toolCallId: "tc_001", toolName: "query_data",
      content: [{ type: "text", text: "返回 10 行数据，包含 date, product, amount 列" }],
      isError: false, timestamp: 1704067266000,
    },
  },

  // 助手回复（含可视化调用）
  {
    type: "message", id: "a2", parentId: "tr1", timestamp: "2026-01-01T00:01:10Z",
    message: {
      role: "assistant", content: [
        { type: "text", text: "查询结果显示销售趋势良好。让我生成一个图表。" },
        {
          type: "toolCall", id: "tc_002", name: "visualize",
          arguments: { sql: "SELECT date, SUM(amount) FROM sales GROUP BY date", chart_type: "line" },
        },
      ], timestamp: 1704067270000,
    },
  },

  // 工具结果（带图表路径）
  {
    type: "message", id: "tr2", parentId: "a2", timestamp: "2026-01-01T00:01:11Z",
    message: {
      role: "toolResult", toolCallId: "tc_002", toolName: "visualize",
      content: [{ type: "text", text: "Chart generated: .pi-data-agent/output/chart_1234.png" }],
      isError: false, timestamp: 1704067271000,
    },
  },

  // 用户追问
  {
    type: "message", id: "u2", parentId: "tr2", timestamp: "2026-01-01T00:02:00Z",
    message: { role: "user", content: "再看看各产品的占比", timestamp: 1704067320000 },
  },

  // Branch summary — 非消息类型，应被过滤
  { type: "branch_summary", id: "bs1", parentId: "u2", timestamp: "2026-01-01T00:02:01Z", fromId: "a2", summary: "..." },
];

// ============================================================================
// 测试用例
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    failed++;
  }
}

// --- Test 1: 过滤非消息类型 ---
console.log("\nTest 1: Filter non-message entries");
{
  const transcript = getSessionTranscript(MOCK_ENTRIES as any);
  assert(transcript.length === 6, `Expected 6 messages, got ${transcript.length}`);
  assert(transcript.every((m) => m.role !== "unknown"), "No unknown roles");
}

// --- Test 2: 字段完整性 ---
console.log("\nTest 2: Field completeness");
{
  const transcript = getSessionTranscript(MOCK_ENTRIES as any);
  for (const msg of transcript) {
    assert(!!msg.role, `role exists (${msg.entryId})`);
    assert(typeof msg.content === "string", `content is string (${msg.entryId})`);
    assert(!!msg.timestamp, `timestamp exists (${msg.entryId})`);
    assert(!!msg.entryId, `entryId exists (${msg.entryId})`);
  }
}

// --- Test 3: 用户消息内容 ---
console.log("\nTest 3: User message content");
{
  const transcript = getSessionTranscript(MOCK_ENTRIES as any);
  const userMsgs = transcript.filter((m) => m.role === "user");
  assert(userMsgs.length === 2, `Expected 2 user messages, got ${userMsgs.length}`);
  assert(userMsgs[0].content === "帮我分析一下销售数据", "First user message content correct");
  assert(userMsgs[1].content === "再看看各产品的占比", "Second user message content correct");
}

// --- Test 4: 助手消息工具调用提取 ---
console.log("\nTest 4: Assistant tool call extraction");
{
  const transcript = getSessionTranscript(MOCK_ENTRIES as any);
  const assistantMsgs = transcript.filter((m) => m.role === "assistant");
  assert(assistantMsgs.length === 2, `Expected 2 assistant messages, got ${assistantMsgs.length}`);

  // 第一个 assistant 有 1 个 toolCall
  assert(assistantMsgs[0].toolCalls?.length === 1, "First assistant has 1 toolCall");
  assert(assistantMsgs[0].toolCalls![0].name === "query_data", "Tool name is query_data");
  assert(assistantMsgs[0].toolCalls![0].argsSummary.includes("SELECT"), "Args summary contains SQL");

  // 第二个 assistant 有 1 个 toolCall
  assert(assistantMsgs[1].toolCalls?.length === 1, "Second assistant has 1 toolCall");
  assert(assistantMsgs[1].toolCalls![0].name === "visualize", "Tool name is visualize");
}

// --- Test 5: 工具调用结果合并 ---
console.log("\nTest 5: Tool result merging");
{
  const transcript = getSessionTranscript(MOCK_ENTRIES as any);
  const merged = mergeToolResults(transcript);

  const assistant1 = merged.find((m) => m.role === "assistant" && m.entryId === "a1");
  assert(assistant1?.toolCalls![0].resultSummary === "返回 10 行数据，包含 date, product, amount 列",
    "First toolCall result merged correctly");

  const assistant2 = merged.find((m) => m.role === "assistant" && m.entryId === "a2")!;
  assert(assistant2.toolCalls![0].resultSummary.includes("chart_1234.png"),
    "Second toolCall result merged correctly");
  assert(assistant2.toolCalls![0].isError === false, "isError is false");
}

// --- Test 6: toolResult 消息包含 toolCallId ---
console.log("\nTest 6: toolResult preserves toolCallId");
{
  const transcript = getSessionTranscript(MOCK_ENTRIES as any);
  const toolResults = transcript.filter((m) => m.role === "toolResult");
  assert(toolResults.length === 2, `Expected 2 toolResult messages, got ${toolResults.length}`);
  assert(toolResults[0].toolCallId === "tc_001", "First toolResult toolCallId correct");
  assert(toolResults[1].toolCallId === "tc_002", "Second toolResult toolCallId correct");
  assert(toolResults[0].toolName === "query_data", "First toolResult toolName correct");
}

// --- Test 7: 空输入 ---
console.log("\nTest 7: Empty input");
{
  const transcript = getSessionTranscript([]);
  assert(transcript.length === 0, "Empty input returns empty array");
}

// --- Test 8: 思考内容不泄露到文本 ---
console.log("\nTest 8: Thinking content not in text");
{
  const entries = [
    {
      type: "message", id: "a_t", parentId: null, timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant", content: [
          { type: "thinking", thinking: "I need to think about this..." },
          { type: "text", text: "Here is my answer." },
        ], timestamp: 1704067200000,
      },
    },
  ];
  const transcript = getSessionTranscript(entries as any);
  assert(transcript[0].content === "Here is my answer.", "Thinking content excluded from text");
}

// ============================================================================
// 汇总
// ============================================================================

if (failed > 0) {
  throw new Error(`${failed} assertion(s) failed`);
}
}

defineScriptSuite("session-report", run);
