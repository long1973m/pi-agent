import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 测试文件根目录
    root: ".",
    // 匹配 src/eval 下的 .test.ts 文件
    include: ["src/eval/**/*.test.ts"],
    // 排除 run-all 脚本和 fixtures
    // 约定：vitest 用例必须 import from "vitest"；带顶层 runXXX()+process.exit 的
    // tsx 独立脚本及 node:test 风格用例不适用 vitest，由 npx tsx / npm run test:legacy 执行
    exclude: [
      "src/eval/run-all-v2.ts",
      "src/eval/fixtures/**",
      // —— node:test 风格（v0.7/v0.8，按 npx tsx 方式执行）——
      "src/eval/analysis-report.test.ts",
      "src/eval/chart-merge.test.ts",
      "src/eval/dictionary-inference.test.ts",
      "src/eval/dictionary-inference-api.test.ts",
      "src/eval/dictionary-review.test.ts",
      "src/eval/report-path-sync.test.ts",
      "src/eval/report-quality-gate.test.ts",
      "src/eval/reports-module-ui.test.ts",
      "src/eval/sql-history-edit.test.ts",
      // —— tsx 独立脚本（顶层 runXXX().catch + process.exit）——
      "src/eval/audit-log.test.ts",
      "src/eval/build-index.test.ts",
      "src/eval/business-scenarios.test.ts",
      "src/eval/caliber.test.ts",
      "src/eval/connect-database.test.ts",
      "src/eval/dashboard-api.test.ts",
      "src/eval/dashboard-security.test.ts",
      "src/eval/dashboard-storage.test.ts",
      "src/eval/dictionary-panel.test.ts",
      "src/eval/failed-query.test.ts",
      "src/eval/integration-phase1.test.ts",
      "src/eval/integration-phase2.test.ts",
      "src/eval/integration-phase3.test.ts",
      "src/eval/pii-guard.test.ts",
      "src/eval/regression.test.ts",
      "src/eval/render-report.test.ts",
      "src/eval/schema-fingerprint.test.ts",
      "src/eval/session-report.test.ts",
      "src/eval/show-image.test.ts",
      "src/eval/sql-highlight.test.ts",
      "src/eval/task6-should-have.test.ts",
      "src/eval/visualize.test.ts",
    ],
    // 运行环境（纯逻辑测试用 node 即可）
    environment: "node",
    // 超时时间（部分测试需要初始化 DuckDB）
    testTimeout: 30_000,
    // 单线程运行（DuckDB 单连接需要串行）
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // 覆盖率收集（可选）
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/eval/**", "src/**/*.test.ts", "src/poc/**"],
    },
  },
});
