/**
 * 测试适配器 — 让自定义断言测试与 vitest 统一
 *
 * 使用方式：
 *   import { createTestSuite } from "./helpers/test-adapter.js";
 *
 *   createTestSuite("My Module", (assert) => {
 *     assert("should pass", 1 + 1 === 2);
 *     assert("should fail", false, "expected true");
 *   });
 *
 * 在 vitest 下运行时，每个 assert 变成一个 it() 用例。
 * 在独立运行时（npx tsx），输出与原来相同的 console.log 格式。
 */

// 检测是否在 vitest 环境下运行
const isVitest =
  typeof (globalThis as any).vi !== "undefined" ||
  typeof (globalThis as any).vitest !== "undefined" ||
  (typeof process !== "undefined" && process.env?.VITEST === "true");

/** 断言函数类型 */
export type AssertFunction = (name: string, condition: boolean, detail?: string) => void;

/**
 * 创建同步测试套件
 */
export function createTestSuite(
  name: string,
  fn: (assert: AssertFunction) => void,
): void {
  if (isVitest) {
    const { describe, it } = require("vitest");
    const assertions: Array<[string, boolean, string?]> = [];

    const collectAssert: AssertFunction = (testName, condition, detail) => {
      assertions.push([testName, condition, detail]);
    };

    fn(collectAssert);

    describe(name, () => {
      for (const [testName, condition, detail] of assertions) {
        it(testName, () => {
          if (!condition) {
            throw new Error(detail || "assertion failed");
          }
        });
      }
    });
  } else {
    let passed = 0;
    let failed = 0;
    console.log(`\n=== ${name} ===\n`);

    fn((testName, condition, detail) => {
      if (condition) {
        console.log(`  ✅ ${testName}`);
        passed++;
      } else {
        console.log(`  ❌ ${testName}${detail ? `: ${detail}` : ""}`);
        failed++;
      }
    });

    printSummary(name, passed, failed);
    if (failed > 0) process.exitCode = 1;
  }
}

/**
 * 创建异步测试套件
 */
export async function createAsyncTestSuite(
  name: string,
  fn: (assert: AssertFunction) => Promise<void>,
): Promise<void> {
  if (isVitest) {
    const { describe, it } = require("vitest");
    const errors: string[] = [];
    const passedNames: string[] = [];

    const assert: AssertFunction = (testName, condition, detail) => {
      if (condition) {
        passedNames.push(testName);
      } else {
        errors.push(`${testName}${detail ? `: ${detail}` : ""}`);
      }
    };

    describe(name, () => {
      it("runs all assertions", async () => {
        await fn(assert);
        if (errors.length > 0) {
          throw new Error(
            `${errors.length} assertion(s) failed:\n  ${errors.join("\n  ")}`,
          );
        }
      });
    });
  } else {
    let passed = 0;
    let failed = 0;
    console.log(`\n=== ${name} ===\n`);

    try {
      await fn((testName, condition, detail) => {
        if (condition) {
          console.log(`  ✅ ${testName}`);
          passed++;
        } else {
          console.log(`  ❌ ${testName}${detail ? `: ${detail}` : ""}`);
          failed++;
        }
      });
      printSummary(name, passed, failed);
      if (failed > 0) process.exitCode = 1;
    } catch (err) {
      console.error(`Suite "${name}" error:`, err);
      process.exitCode = 1;
    }
  }
}

/** 打印汇总信息 */
function printSummary(name: string, passed: number, failed: number): void {
  console.log(`\n--- ${name} Results: ${passed} passed, ${failed} failed ---\n`);
}
