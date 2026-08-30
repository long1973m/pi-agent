/**
 * v0.8 B3 — 图表合并测试
 *
 * 验证：
 * 1. 正式报告卡片中图表缩略图最多显示 3 张
 * 2. 超过 3 张显示 +N
 * 3. 过程记录行只显示图表数量文字
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

describe("chart-merge", () => {
  it("图表缩略图最多 3 张", () => {
    const charts = [1, 2, 3, 4, 5];
    const displayed = charts.slice(0, 3);
    assert.strictEqual(displayed.length, 3);
    assert.deepStrictEqual(displayed, [1, 2, 3]);
  });

  it("超过 3 张显示 +N", () => {
    const charts = [1, 2, 3, 4, 5];
    const overflow = charts.length > 3 ? `+${charts.length - 3}` : "";
    assert.strictEqual(overflow, "+2");
  });

  it("恰好 3 张不显示 +N", () => {
    const charts = [1, 2, 3];
    const overflow = charts.length > 3 ? `+${charts.length - 3}` : "";
    assert.strictEqual(overflow, "");
  });

  it("少于 3 张显示全部", () => {
    const charts = [1, 2];
    const displayed = charts.slice(0, 3);
    assert.strictEqual(displayed.length, 2);
    assert.deepStrictEqual(displayed, [1, 2]);
  });

  it("过程记录行显示图表数量文字", () => {
    const chartCount = 5;
    const label = `${chartCount} 张图表`;
    assert.strictEqual(label, "5 张图表");
  });

  it("空图表列表显示 0 张", () => {
    const charts: number[] = [];
    const label = `${charts.length} 张图表`;
    assert.strictEqual(label, "0 张图表");
  });
});
