/**
 * T-3 — error-recovery 错误恢复测试（vitest）
 *
 * 覆盖:
 * - R1: 首次成功不重试
 * - R2: 无 autoFixFn 时确定性错误只执行 1 次即返回（F-bug① 语义），携带 debugContext
 * - R3: 有 autoFixFn 且修复生效 → 重试后成功
 * - R4: 连续相同错误达到阈值 → 提前停止
 * - R5: autoFixFn 持续失败 → 耗尽 maxRetries 后返回 retried=true
 */

import { describe, it, expect, vi } from "vitest";

import { executeWithRecovery } from "../error-recovery.js";
import type { RecoveryContext } from "../error-recovery.js";

/** stub DuckDBEngine：只提供 gatherDebugContext 需要的 getSchema/getSample */
function stubEngine() {
  return {
    getSchema: async () => [{ name: "a", type: "INTEGER" }],
    getSample: async () => [[1], [2], [3]],
  };
}

const baseContext = (engine: unknown = undefined): RecoveryContext => ({
  sql: "SELECT * FROM t",
  tableName: "t",
  toolName: "query_data",
  engine: engine as RecoveryContext["engine"],
});

describe("error-recovery（T-3）", () => {
  it("R1: 首次成功不重试", async () => {
    const executeFn = vi.fn().mockResolvedValue("ok");

    const result = await executeWithRecovery(executeFn, {}, baseContext());

    expect(result.result).toBe("ok");
    expect(result.error).toBeUndefined();
    expect(result.retried).toBe(false);
    expect(result.retryCount).toBe(0);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  it("R2: 无 autoFixFn 时失败只执行 1 次即返回，携带 debugContext", async () => {
    const executeFn = vi.fn().mockRejectedValue(new Error("Parser Error: syntax error at FROM"));
    const onUpdate = vi.fn();

    const result = await executeWithRecovery(
      executeFn,
      {},
      baseContext(stubEngine()),
      onUpdate,
      // 不传 autoFixFn
    );

    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(result.retried).toBe(false);
    expect(result.retryCount).toBe(0);
    expect(result.error).toContain("syntax error");
    // 调试上下文带 SQL 与 schema
    expect(result.debugContext?.sql).toBe("SELECT * FROM t");
    expect(result.debugContext?.schema?.[0]?.name).toBe("a");
    expect(result.debugContext?.errorMessage).toContain("syntax error");
    // 通知用户“无自动修复可用”而非盲目重试
    expect(onUpdate).toHaveBeenCalledWith(expect.stringContaining("no auto-fix available"));
  });

  it("R3: autoFixFn 修复生效 → 重试一次后成功", async () => {
    let attempts = 0;
    const executeFn = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("Catalog Error: table not found");
      return "fixed-result";
    });
    const autoFixFn = vi.fn(async () => executeFn);

    const result = await executeWithRecovery(
      executeFn,
      {},
      baseContext(),
      undefined,
      autoFixFn,
    );

    expect(result.result).toBe("fixed-result");
    expect(result.retried).toBe(true);
    expect(result.retryCount).toBe(1);
    expect(result.attemptedFixes.some((f) => f.startsWith("Auto-fixed"))).toBe(true);
  });

  it("R4: 连续相同错误达到阈值 → 提前停止", async () => {
    const executeFn = vi.fn().mockRejectedValue(new Error("same error"));

    const result = await executeWithRecovery(
      executeFn,
      { maxRetries: 5, sameErrorThreshold: 3 },
      baseContext(),
      undefined,
      // autoFixFn 返回同一个必败函数，模拟修复无效
      async () => executeFn,
    );

    expect(executeFn).toHaveBeenCalledTimes(3);
    expect(result.error).toContain("same error");
    expect(result.result).toBeUndefined();
    expect(result.retryCount).toBe(2);
  });

  it("R5: autoFixFn 持续失败 → 耗尽 maxRetries 后返回 retried=true", async () => {
    const executeFn = vi.fn().mockRejectedValue(new Error("err"));
    // 每次抛不同错误，避免触发相同错误阈值
    let n = 0;
    const varyingFn = vi.fn(async () => {
      n++;
      throw new Error(`err-${n}`);
    });
    const autoFixFn = vi.fn(async () => varyingFn);

    const result = await executeWithRecovery(
      executeFn,
      { maxRetries: 2, sameErrorThreshold: 10 },
      baseContext(),
      undefined,
      autoFixFn,
    );

    expect(result.result).toBeUndefined();
    expect(result.retried).toBe(true);
    expect(result.retryCount).toBe(2);
    expect(result.error).toContain("err-2");
    // autoFix 路径被记录（autoFixFn 本身成功返回了替换函数，故为 Auto-fixed）
    expect(result.attemptedFixes.some((f) => f.startsWith("Auto-fixed"))).toBe(true);
  });
});
