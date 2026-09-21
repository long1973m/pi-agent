import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 测试内 spawn("python3") 直接使用调用方 PATH（由运行环境保证解释器可用）
    // 测试文件根目录
    root: ".",
    // T-1 统一后：全部测试（原 vitest + node:test + 自定义断言脚本）均为
    // src/eval 下的 .test.ts 文件，glob 直接收口，无需手工 exclude 黑名单。
    // fixtures 目录不是测试文件，仅作数据引用。
    include: ["src/eval/**/*.test.ts"],
    exclude: ["src/eval/fixtures/**"],
    // 运行环境（纯逻辑测试用 node 即可）
    environment: "node",
    // 超时时间（部分测试需要初始化 DuckDB；Python 绘图用例在慢机/冷启动下
    // 单文件可超 30s，2026-09-17 收口实测两次全量均触发误报，故放宽到 60s）
    testTimeout: 60_000,
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
