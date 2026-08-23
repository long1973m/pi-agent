#!/usr/bin/env node
/**
 * v0.2 全量自动化测试入口
 *
 * 运行: npx tsx src/eval/run-all-v2.ts
 *
 * 测试矩阵:
 *   Group V1: visualize 工具（7 种图表 + fallback + 安全）
 *   Group V2: show_image 工具（PNG/SVG + 安全 + fallback）
 *   Group V3: 口径回写（agent.md 写入/去重/截断/注入）
 *   Group V4: Schema fingerprint（计算/刷新/过时闸/降级）
 *   Group V5: 失败查询入库（分类/容量闸/隔离）
 *   Group V6: v0.1 回归（57 条金标准）
 *
 * 设计原则:
 *   - 每个测试文件独立运行，任一失败不影响其他
 *   - 输出 JSON 格式报告到 .pi-data-agent/eval/report-v2.json
 *   - 最终汇总通过/失败数
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

interface TestGroup {
  id: string;
  label: string;
  script: string;
}

const TEST_CWD = cwd();
const EVAL_DIR = join(TEST_CWD, ".pi-data-agent", "eval");

const GROUPS: TestGroup[] = [
  { id: "V1", label: "visualize 工具",         script: "src/eval/visualize.test.ts" },
  { id: "V2", label: "show_image 工具",        script: "src/eval/show-image.test.ts" },
  { id: "V3", label: "口径回写 (agent.md)",     script: "src/eval/caliber.test.ts" },
  { id: "V4", label: "Schema fingerprint 过时闸", script: "src/eval/schema-fingerprint.test.ts" },
  { id: "V5", label: "失败查询入库",            script: "src/eval/failed-query.test.ts" },
  { id: "V6", label: "v0.1 回归 (57 条金标准)",  script: "src/eval/regression.test.ts" },
];

interface GroupResult {
  id: string;
  label: string;
  status: "passed" | "failed" | "error";
  duration: number;
  passedCount: number;
  failedCount: number;
}

/**
 * 从测试输出解析断言数
 * 支持两种格式：
 *   "Results: N passed, M failed" （v0.2 新测试）
 *   "Passed: N / Failed: M"       （v0.1 回归测试）
 */
function parseAssertionCounts(output: string): { passed: number; failed: number } {
  const m1 = output.match(/Results:\s*(\d+)\s+passed,\s*(\d+)\s+failed/);
  if (m1) return { passed: parseInt(m1[1]), failed: parseInt(m1[2]) };

  const mp = output.match(/Passed:\s*(\d+)/);
  const mf = output.match(/Failed:\s*(\d+)/);
  return {
    passed: mp ? parseInt(mp[1]) : 0,
    failed: mf ? parseInt(mf[1]) : 0,
  };
}

async function main(): Promise<void> {
  console.log("=== v0.2 Full Automated Test Suite ===\n");

  mkdirSync(EVAL_DIR, { recursive: true });

  const results: GroupResult[] = [];
  let totalPassed = 0;
  let totalFailed = 0;

  for (const group of GROUPS) {
    const startTime = Date.now();
    process.stdout.write(`[${group.id}] ${group.label} ... `);

    try {
      const output = execSync(`npx tsx ${group.script}`, {
        cwd: TEST_CWD,
        timeout: 120_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      const duration = Date.now() - startTime;
      const counts = parseAssertionCounts(output);
      const status: GroupResult["status"] = counts.failed === 0 ? "passed" : "failed";

      totalPassed += counts.passed;
      totalFailed += counts.failed;

      results.push({ id: group.id, label: group.label, status, duration, passedCount: counts.passed, failedCount: counts.failed });
      const msg = status === "passed"
        ? `✅ PASSED (${counts.passed} assertions, ${duration}ms)`
        : `❌ FAILED (${counts.passed} passed, ${counts.failed} failed, ${duration}ms)`;
      console.log(msg);
    } catch (err: any) {
      const duration = Date.now() - startTime;
      const outputStr = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
      const counts = parseAssertionCounts(outputStr);

      if (counts.passed + counts.failed > 0) {
        // 断言测试但失败了（exit code 1）
        totalPassed += counts.passed;
        totalFailed += counts.failed;
        results.push({ id: group.id, label: group.label, status: "failed", duration, passedCount: counts.passed, failedCount: counts.failed });
        console.log(`❌ FAILED (${counts.passed} passed, ${counts.failed} failed, ${duration}ms)`);
      } else {
        // 运行时错误（没有解析到断言数）
        totalFailed += 1;
        results.push({ id: group.id, label: group.label, status: "error", duration, passedCount: 0, failedCount: 0 });
        console.log(`💥 ERROR (${duration}ms) — ${err.message?.slice(0, 80)}`);
      }
    }
  }

  // ========================================================================
  // 汇总报告
  // ========================================================================
  console.log("\n=== v0.2 Test Suite Summary ===\n");
  console.log("Group  | Status   | Assertions        | Time");
  console.log("-------|----------|-------------------|------");
  for (const r of results) {
    const statusStr = r.status === "passed" ? "✅ PASS" : r.status === "failed" ? "❌ FAIL" : "💥 ERR ";
    const assertStr = `${r.passedCount} passed, ${r.failedCount} failed`;
    console.log(`${r.id}     | ${statusStr}  | ${assertStr.padEnd(18)}| ${r.duration}ms`);
  }
  console.log("-------|----------|-------------------|------");
  console.log(`Total  | ${totalFailed === 0 ? "✅ ALL PASS" : "❌ HAS FAIL"} | ${totalPassed} passed, ${totalFailed} failed`);

  // 写入 JSON 报告
  const report = {
    timestamp: new Date().toISOString(),
    version: "v0.2",
    groups: results.map((r) => ({
      id: r.id,
      label: r.label,
      status: r.status,
      durationMs: r.duration,
      passedCount: r.passedCount,
      failedCount: r.failedCount,
    })),
    summary: {
      totalPassed,
      totalFailed,
      totalGroups: results.length,
      passedGroups: results.filter((r) => r.status === "passed").length,
    },
  };

  const reportPath = join(EVAL_DIR, "report-v2.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\nReport saved to: ${reportPath}`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner fatal error:", err);
  process.exit(1);
});
