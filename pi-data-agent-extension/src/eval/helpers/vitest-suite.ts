/**
 * vitest 套件包装器（T-1 测试框架统一）
 *
 * 原自定义断言脚本（npx tsx 直跑、自带 assert 计数与 process.exit）
 * 迁移到 vitest 时使用：整个脚本的所有断言在一个 it() 内按原顺序执行，
 * 保持原有执行顺序与共享状态语义不变；脚本内任何断言失败（throw）
 * 即该用例失败。断言结果摘要仍由脚本自身的 console.log 输出。
 */

import { describe, it } from "vitest";

export function defineScriptSuite(
  name: string,
  run: () => Promise<void> | void,
): void {
  describe(name, () => {
    it("all assertions", async () => {
      await run();
    });
  });
}
