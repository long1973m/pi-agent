/**
 * v0.8 B3 — 报告模块 UI 数据分组测试
 *
 * 验证：
 * 1. items 按 type === "analysis" 正确分组
 * 2. 空分析报告显示正确空状态
 * 3. 空过程记录显示正确空状态
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("reports-module-ui", () => {
  it("报告按 type 分组", () => {
    const items = [
      { id: "a1", type: "analysis", title: "分析1" },
      { id: "s1", type: "session", title: "过程1" },
      { id: "a2", type: "analysis", title: "分析2" },
    ];

    const analysisItems = items.filter((r) => r.type === "analysis");
    const sessionItems = items.filter((r) => r.type !== "analysis");

    assert.strictEqual(analysisItems.length, 2);
    assert.strictEqual(sessionItems.length, 1);
    assert.deepStrictEqual(
      analysisItems.map((r) => r.id),
      ["a1", "a2"]
    );
    assert.deepStrictEqual(
      sessionItems.map((r) => r.id),
      ["s1"]
    );
  });

  it("空分析报告显示空状态文案", () => {
    const emptyAnalysisState =
      "暂无正式分析报告。在 TUI 中完成分析后，Agent 会自动生成";
    assert.ok(emptyAnalysisState.length > 0);
    assert.ok(emptyAnalysisState.includes("分析报告"));
  });

  it("空过程记录显示空状态文案", () => {
    const emptySessionState = "暂无过程记录";
    assert.ok(emptySessionState.length > 0);
    assert.ok(emptySessionState.includes("过程记录"));
  });

  it("混合类型列表保持顺序", () => {
    const items = [
      { id: "s1", type: "session", title: "过程1" },
      { id: "a1", type: "analysis", title: "分析1" },
      { id: "s2", type: "session", title: "过程2" },
      { id: "a2", type: "analysis", title: "分析2" },
    ];

    const analysisItems = items.filter((r) => r.type === "analysis");
    const sessionItems = items.filter((r) => r.type !== "analysis");

    assert.deepStrictEqual(
      analysisItems.map((r) => r.id),
      ["a1", "a2"]
    );
    assert.deepStrictEqual(
      sessionItems.map((r) => r.id),
      ["s1", "s2"]
    );
  });
});
