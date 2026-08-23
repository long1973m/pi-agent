/**
 * 阶段2 集成验证 (I2.1, I2.2, I2.3)
 *
 * I2.1: 第一次"分析活跃用户" → 触发反问 → 选择 → agent.md 写入
 * I2.2: 第二次"分析活跃用户" → 不反问，复用口径
 * I2.3: v0.1 回归无退化
 *
 * 运行: npx tsx src/eval/integration-phase2.test.ts
 */

import { loadConfig, toSecurityConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { SecurityChecker } from "../security.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { createAskClarificationTool } from "../tools/ask-clarification.js";
import { createActiveQuestioningHandler } from "../hooks/active-questioning.js";
import { DataDictionaryManager } from "../hooks/data-dictionary.js";
import type { ToolContext } from "../tools/tool-context.js";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

const TEST_CWD = cwd();

const mockCtx = {
  ui: null,
  cwd: TEST_CWD,
  sessionManager: { getBranch: () => [], appendEntry: () => {} },
} as any;

async function runIntegrationTests(): Promise<void> {
  console.log("=== Phase 2 Integration Tests (I2.1, I2.2, I2.3) ===\n");
  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, detail?: string): void {
    if (condition) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.log(`  ❌ ${name}${detail ? `: ${detail}` : ""}`);
      failed++;
    }
  }

  // Setup
  const config = loadConfig();
  const persistence = new PersistenceManager(config.globalConfigDir, config.projectConfigDir);
  persistence.saveDataDictionary([], "project");
  persistence.saveQueryMemory({ maxEntries: 5, entries: [] }, "project");

  const security = new SecurityChecker(toSecurityConfig(config));
  const engine = new DuckDBEngine({
    dbPath: config.dbPath,
    previewLimit: config.previewLimit,
    outputDir: config.outputDir,
  });
  await engine.init();

  const dataDictionary = new DataDictionaryManager(persistence);

  const toolContext: ToolContext = {
    engine,
    security,
    persistence,
    cwd: config.cwd,
    config,
    dataDictionary,
    queryMemory: {} as any,
  };

  const getRuntime = () => toolContext;
  const askTool = createAskClarificationTool({ getRuntime });

  // 清理 agent.md
  const agentMdPath = join(config.projectConfigDir, "agent.md");
  try { unlinkSync(agentMdPath); } catch { /* ignore */ }

  // ========================================================================
  // I2.1: 第一次"分析活跃用户" → 触发反问 → 选择 → agent.md 写入
  // ========================================================================
  console.log("[I2.1] First '分析活跃用户' → clarify → save caliber");

  // Step 1: detectAmbiguity 对"分析活跃用户"返回歧义
  const testSql = "SELECT * FROM users WHERE active = true";
  const handler = createActiveQuestioningHandler({
    dictionaryManager: dataDictionary,
    getEngine: () => engine,
  });

  // 模拟 query_data tool_call 事件（无字典，应触发 block）
  const blockResult = await handler(
    {
      toolName: "query_data",
      toolCallId: "test-i21",
      input: { sql: testSql, table_name: "users", user_intent: "分析活跃用户" },
    } as any,
    mockCtx
  );
  assert("I2.1: ambiguity detected (blocked)", blockResult?.block === true, JSON.stringify(blockResult));

  // Step 2: ask_clarification 执行（非交互模式，自动选 default）
  const clarifyResult = await askTool.execute(
    "test-clarify-1",
    {
      question: "活跃用户的定义是什么？",
      why: '\u201c活跃用户\u201d可能有不同定义',
      options: [
        { id: "login_7d", label: "最近7天有登录", implied_assumption: "活跃用户 = 最近7天有登录记录的用户" },
        { id: "login_30d", label: "最近30天有登录", implied_assumption: "活跃用户 = 最近30天有登录记录的用户" },
      ],
      default_if_skip: "login_7d",
    },
    undefined, undefined, mockCtx
  );
  const clarifyDetails = clarifyResult.details as Record<string, any> | undefined;
  assert("I2.1: clarification executed", clarifyDetails?.answer?.appliedAssumption === "活跃用户 = 最近7天有登录记录的用户");

  // Step 3: agent.md 写入验证
  assert("I2.1: agent.md exists", existsSync(agentMdPath));
  const agentMdContent = JSON.parse(readFileSync(agentMdPath, "utf-8"));
  assert("I2.1: caliber saved", agentMdContent.length === 1);
  assert("I2.1: caliber question correct", agentMdContent[0].question === "活跃用户的定义是什么？");
  assert("I2.1: caliber definition correct", agentMdContent[0].definition === "最近7天有登录");

  // ========================================================================
  // I2.2: 第二次"分析活跃用户" → 不反问，复用口径
  // ========================================================================
  console.log("\n[I2.2] Second '分析活跃用户' → reuse caliber, no re-clarify");

  // Step 1: hasCaliberForQuestion 对已记录问题返回 true
  assert("I2.2: hasCaliberForQuestion returns true", persistence.hasCaliberForQuestion("活跃用户的定义是什么？"));

  // Step 2: 模拟第二次 query_data，此时应有口径（但 active-questioning hook 不检查 caliber，只检查字典和歧义）
  // 注意：当前 active-questioning 不直接检查 caliber，caliber 是通过 system prompt 注入让 Agent 不复用
  // 这里验证 system prompt 注入逻辑
  const calibers = persistence.getRecentCalibers(10);
  assert("I2.2: caliber available for injection", calibers.length === 1);
  assert("I2.2: caliber contains assumption", calibers[0].appliedAssumption === "活跃用户 = 最近7天有登录记录的用户");

  // ========================================================================
  // I2.3: v0.1 回归无退化
  // ========================================================================
  console.log("\n[I2.3] v0.1 regression check");

  // 快速验证核心工具仍可用
  const { createLoadDataTool } = await import("../tools/load-data.js");
  const { createExportResultTool } = await import("../tools/export-result.js");

  const loadTool = createLoadDataTool({ getRuntime });
  const exportTool = createExportResultTool({ getRuntime });

  // 创建测试 CSV
  const testCsvPath = join(config.outputDir, "regression-test.csv");
  const fs = await import("node:fs");
  fs.writeFileSync(testCsvPath, "a,b\n1,2\n3,4\n");

  const loadResult = await loadTool.execute("reg-load", { file_path: testCsvPath }, undefined, undefined, mockCtx);
  const loadDetails = loadResult.details as Record<string, any> | undefined;
  assert("I2.3: load_data works", loadDetails?.tableName === "regression_test");

  const exportResult = await exportTool.execute("reg-export", { sql: "SELECT * FROM regression_test", format: "csv", output_path: join(config.outputDir, "regression-export.csv") }, undefined, undefined, mockCtx);
  const exportDetails = exportResult.details as Record<string, any> | undefined;
  assert("I2.3: export_result works", exportDetails?.rowCount === 2);

  // Cleanup
  await engine.close();
  try { unlinkSync(agentMdPath); } catch { /* ignore */ }
  try { unlinkSync(testCsvPath); } catch { /* ignore */ }
  try { unlinkSync(join(config.outputDir, "regression-export.csv")); } catch { /* ignore */ }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runIntegrationTests().catch((err) => {
  console.error("Integration test error:", err);
  process.exit(1);
});
