import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

// Python 绘图环境（T-1）：若存在专用 venv，则前置到 PATH，
// 使测试内 spawn("python3") 能命中带 matplotlib/pandas/seaborn 的解释器。
const chartVenvBin = "/Users/mare/.workbuddy/binaries/python/envs/chart/bin";
const chartPathPrefix = existsSync(chartVenvBin)
  ? { PATH: `${chartVenvBin}${delimiter}${process.env.PATH ?? ""}` }
  : {};

export default defineConfig({
  test: {
    // Python 绘图 venv 注入（visualize / integration 测试依赖）
    env: chartPathPrefix,
    // 测试文件根目录
    root: ".",
    // T-1 统一后：全部测试（原 vitest + node:test + 自定义断言脚本）均为
    // src/eval 下的 .test.ts 文件，glob 直接收口，无需手工 exclude 黑名单。
    // fixtures 目录不是测试文件，仅作数据引用。
    include: ["src/eval/**/*.test.ts"],
    exclude: ["src/eval/fixtures/**"],
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
