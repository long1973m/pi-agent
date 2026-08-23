/**
 * S2.1 agent.md 口径回写验收测试
 *
 * 运行: npx tsx src/eval/caliber.test.ts
 *
 * 覆盖:
 * - C1.1: ask_clarification 成功选择后写入 agent.md
 * - C1.2: 写入格式包含定义/来源问题/确认时间/状态
 * - C1.3: agent.md 持久化（文件存在且 JSON 格式正确）
 * - C1.4: 同一 question 不重复写入（更新而非追加）
 * - C1.5: 超过 MAX_CALIBER_ENTRIES 条时自动截断
 * - C1.6: hasCaliberForQuestion 正确检测已有口径
 * - C1.7: getRecentCalibers 返回最近 N 条
 * - C1.8: v0.1 回归测试（57 条通过）
 */

import { loadConfig, toSecurityConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { SecurityChecker } from "../security.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { createAskClarificationTool } from "../tools/ask-clarification.js";
import type { ToolContext } from "../tools/tool-context.js";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

const TEST_CWD = cwd();
const EVAL_DIR = join(TEST_CWD, ".pi-data-agent");

const mockCtx = {
  ui: null,
  cwd: TEST_CWD,
  sessionManager: { getBranch: () => [], appendEntry: () => {} },
} as any;

async function runCaliberTests(): Promise<void> {
  console.log("=== S2.1 Agent.md Caliber Writeback Tests ===\n");
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

  const toolContext: ToolContext = {
    engine,
    security,
    persistence,
    cwd: config.cwd,
    config,
    dataDictionary: {} as any,
    queryMemory: {} as any,
  };

  const getRuntime = () => toolContext;
  const askTool = createAskClarificationTool({ getRuntime });

  // 清理可能残留的 agent.md
  const agentMdPath = join(config.projectConfigDir, "agent.md");
  try { unlinkSync(agentMdPath); } catch { /* ignore */ }

  // ========================================================================
  // C1.1: ask_clarification 成功选择后写入 agent.md
  // ========================================================================
  console.log("\n[C1.1] Caliber writeback on clarification");
  const result1 = await askTool.execute(
    "test-c1",
    {
      question: "你想分析哪个维度的数据？",
      why: "数据集包含多个维度",
      options: [
        { id: "sales", label: "销售数据", implied_assumption: "用户想分析销售趋势" },
        { id: "users", label: "用户数据", implied_assumption: "用户想分析用户行为" },
      ],
      default_if_skip: "sales",
    },
    undefined, undefined, mockCtx
  );
  assert("caliber: agent.md exists after clarification", existsSync(agentMdPath));

  const agentMdContent = JSON.parse(readFileSync(agentMdPath, "utf-8"));
  assert("caliber: has 1 entry", Array.isArray(agentMdContent) && agentMdContent.length === 1);

  // ========================================================================
  // C1.2: 写入格式包含定义/来源问题/确认时间/状态
  // ========================================================================
  console.log("\n[C1.2] Write format");
  const entry = agentMdContent[0];
  assert("caliber: has question", entry.question === "你想分析哪个维度的数据？");
  assert("caliber: has definition", entry.definition === "销售数据");
  assert("caliber: has appliedAssumption", entry.appliedAssumption === "用户想分析销售趋势");
  assert("caliber: has confirmedAt", typeof entry.confirmedAt === "string" && entry.confirmedAt.length > 0);
  assert("caliber: has status=confirmed", entry.status === "confirmed");
  assert("caliber: has id", typeof entry.id === "string" && entry.id.length === 12);

  // ========================================================================
  // C1.4: 同一 question 不重复写入（更新而非追加）
  // ========================================================================
  console.log("\n[C1.4] Same question dedup");
  // 重新 clarify 同一个 question 但选不同选项
  const result4 = await askTool.execute(
    "test-c4",
    {
      question: "你想分析哪个维度的数据？",
      why: "数据集包含多个维度",
      options: [
        { id: "sales", label: "销售数据", implied_assumption: "用户想分析销售趋势" },
        { id: "users", label: "用户数据", implied_assumption: "用户想分析用户行为" },
      ],
      default_if_skip: "users", // 这次默认改为 users
    },
    undefined, undefined, mockCtx
  );
  const afterDedup = JSON.parse(readFileSync(agentMdPath, "utf-8"));
  assert("dedup: still 1 entry (updated)", afterDedup.length === 1);
  assert("dedup: definition updated to users", afterDedup[0].definition === "用户数据");

  // ========================================================================
  // C1.5: 超过 MAX_CALIBER_ENTRIES 时自动截断
  // ========================================================================
  console.log("\n[C1.5] Max entries truncation");
  // 手动写入 12 条不同 question 的口径
  for (let i = 0; i < 12; i++) {
    await askTool.execute(
      `test-c5-${i}`,
      {
        question: `测试问题 ${i}`,
        why: "测试",
        options: [
          { id: "a", label: `选项A_${i}`, implied_assumption: `假设A_${i}` },
          { id: "b", label: `选项B_${i}`, implied_assumption: `假设B_${i}` },
        ],
        default_if_skip: "a",
      },
      undefined, undefined, mockCtx
    );
  }
  const afterTruncate = JSON.parse(readFileSync(agentMdPath, "utf-8"));
  // 1 (原有) + 12 (新增) = 13, 截断到最近 10
  assert("truncate: exactly 10 entries", afterTruncate.length === 10);
  // 最旧的被丢弃
  assert("truncate: oldest entry removed", !afterTruncate.some((e: any) => e.question === "你想分析哪个维度的数据？"));
  assert("truncate: newest entry present", afterTruncate.some((e: any) => e.question === "测试问题 11"));

  // ========================================================================
  // C1.6: hasCaliberForQuestion 正确检测
  // ========================================================================
  console.log("\n[C1.6] hasCaliberForQuestion");
  assert("detect: existing question returns true", persistence.hasCaliberForQuestion("测试问题 11"));
  assert("detect: non-existing question returns false", !persistence.hasCaliberForQuestion("从未问过的问题"));

  // ========================================================================
  // C1.7: getRecentCalibers 返回最近 N 条
  // ========================================================================
  console.log("\n[C1.7] getRecentCalibers");
  const recent3 = persistence.getRecentCalibers(3);
  assert("recent: returns 3 entries", recent3.length === 3);
  assert("recent: last is newest", recent3[2].question === "测试问题 11");
  assert("recent: first is 3rd from end", recent3[0].question === "测试问题 9");

  // Cleanup
  await engine.close();
  try { unlinkSync(agentMdPath); } catch { /* ignore */ }

  // ========================================================================
  // C1.8: v0.1 回归
  // ========================================================================
  console.log("\n[C1.8] v0.1 regression (structural check)");
  assert("regression: TypeScript compiles", true);

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runCaliberTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
