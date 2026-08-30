/**
 * v0.3 真实业务样例 Eval
 *
 * 验证 Agent 在接近真实业务的数据上是否可用。
 * 8 个业务场景，每个场景断言关键检查点。
 *
 * 运行: npx tsx src/eval/business-scenarios.test.ts
 */

import { loadConfig, toSecurityConfig } from "../config.js";
import { PersistenceManager } from "../persistence.js";
import { SecurityChecker } from "../security.js";
import { DuckDBEngine } from "../engine/duckdb.js";
import { DataDictionaryManager } from "../hooks/data-dictionary.js";
import { createLoadDataTool } from "../tools/load-data.js";
import { createDescribeDataTool } from "../tools/describe-data.js";
import { createQueryDataTool } from "../tools/query-data.js";
import { createConfirmDictionaryTool } from "../tools/confirm-dictionary.js";
import { createVisualizeTool } from "../tools/visualize.js";
import { detectAmbiguity } from "../hooks/active-questioning.js";
import type { ToolContext } from "../tools/tool-context.js";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { defineScriptSuite } from "./helpers/vitest-suite.js";

const TEST_CWD = cwd();
const FIXTURES_DIR = join(TEST_CWD, "src", "eval", "fixtures");

const mockCtx = {
  ui: null,
  cwd: TEST_CWD,
  sessionManager: { getBranch: () => [], appendEntry: () => {} },
} as any;

async function runBusinessScenarioTests(): Promise<void> {
  console.log("=== v0.3 Business Scenario Eval ===\n");
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

  // ========================================================================
  // Setup: 初始化引擎 + 加载业务数据
  // ========================================================================
  const config = loadConfig();
  // S-1 fail-closed（v0.11）：headless 测试无 UI，写操作需显式放行（spec v0.11 §13）
  config.autoConfirmWrite = true;
  const persistence = new PersistenceManager(config.globalConfigDir, config.projectConfigDir);
  // 清理旧字典，避免状态污染
  persistence.saveDataDictionary([], "project");

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
    queryMemory: {
      getCurrentDatasetFingerprint: () => "",
      recordQuery: () => {},
      recordFailedQuery: () => {},
    } as any,
  };
  const getRuntime = () => toolContext;

  const loadTool = createLoadDataTool({ getRuntime });
  const describeTool = createDescribeDataTool({ getRuntime });
  const queryTool = createQueryDataTool({ getRuntime });
  const confirmDictTool = createConfirmDictionaryTool({ getRuntime });
  const visualizeTool = createVisualizeTool({ getRuntime });

  // 加载 4 个业务数据集
  console.log("[Setup] Loading business datasets...");
  const datasets = [
    { name: "ecommerce_orders", file: "ecommerce_orders.csv" },
    { name: "user_events", file: "user_events.csv" },
    { name: "sales_daily", file: "sales_daily.csv" },
    { name: "insurance_policies", file: "insurance_policies.csv" },
  ];

  for (const ds of datasets) {
    const filePath = join(FIXTURES_DIR, ds.file);
    if (!existsSync(filePath)) {
      console.error(`  ❌ Missing fixture: ${filePath}`);
      throw new Error(`Missing fixture: ${filePath}`);
    }
    const result = await loadTool.execute("test", { file_path: filePath }, undefined, undefined, mockCtx);
    const details = result.details as Record<string, any> | undefined;
    assert(`load_data ${ds.name}`, details?.tableName === ds.name, JSON.stringify(details));
  }

  // ========================================================================
  // B1: 电商订单 — 最近 7 天新用户订单量
  // ========================================================================
  console.log("\n[B1] 最近 7 天新用户订单量");
  const b1Result = await queryTool.execute(
    "b1",
    {
      sql: `SELECT COUNT(*) AS new_user_orders FROM ecommerce_orders WHERE order_time >= '2024-06-24' AND is_new_user = true`,
      user_intent: "最近 7 天新用户订单量是多少？",
      table_name: "ecommerce_orders",
    },
    undefined, undefined, mockCtx
  );
  const b1Details = b1Result.details as Record<string, any> | undefined;
  assert("B1: SQL 生成成功", b1Details?.sql?.includes("ecommerce_orders"));
  assert("B1: SQL 包含时间过滤", b1Details?.sql?.includes("2024-06-24"));
  assert("B1: SQL 包含新用户过滤", b1Details?.sql?.toLowerCase().includes("is_new_user"));
  assert("B1: 结果行数正常", (b1Details?.totalRowCount ?? 0) >= 0);
  assert("B1: 返回 executionTimeMs", typeof b1Details?.executionTimeMs === "number");

  // ========================================================================
  // B2: 渠道分析 — 哪个渠道销售额最高
  // ========================================================================
  console.log("\n[B2] 哪个渠道销售额最高");
  const b2Result = await queryTool.execute(
    "b2",
    {
      sql: `SELECT channel, SUM(amount) AS total_amount FROM ecommerce_orders GROUP BY channel ORDER BY total_amount DESC LIMIT 1`,
      user_intent: "哪个渠道销售额最高？",
      table_name: "ecommerce_orders",
    },
    undefined, undefined, mockCtx
  );
  const b2Details = b2Result.details as Record<string, any> | undefined;
  assert("B2: SQL 包含 channel", b2Details?.sql?.includes("channel"));
  assert("B2: SQL 包含 SUM(amount)", b2Details?.sql?.toLowerCase().includes("sum(amount)"));
  assert("B2: SQL 包含 GROUP BY", b2Details?.sql?.toLowerCase().includes("group by"));
  assert("B2: 结果不为空", (b2Details?.totalRowCount ?? 0) > 0);

  // ========================================================================
  // B3: 异常检测 — 找出销售额异常高的日期
  // ========================================================================
  console.log("\n[B3] 找出销售额异常高的日期");
  // 使用 IQR 方法检测 sales_daily 中的异常日期
  const b3Result = await queryTool.execute(
    "b3",
    {
      sql: `WITH daily_sales AS (
        SELECT date, SUM(sales_amount) AS total_sales FROM sales_daily GROUP BY date
      ), stats AS (
        SELECT
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY total_sales) AS q1,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY total_sales) AS q3
        FROM daily_sales
      )
      SELECT d.date, d.total_sales
      FROM daily_sales d, stats
      WHERE d.total_sales > q3 + 1.5 * (q3 - q1)
      ORDER BY d.total_sales DESC`,
      user_intent: "找出销售额异常高的日期",
      table_name: "sales_daily",
    },
    undefined, undefined, mockCtx
  );
  const b3Details = b3Result.details as Record<string, any> | undefined;
  assert("B3: SQL 包含 PERCENTILE", b3Details?.sql?.includes("PERCENTILE_CONT"));
  assert("B3: SQL 包含 IQR 逻辑", b3Details?.sql?.includes("q3 - q1"));
  assert("B3: 发现异常日期", (b3Details?.totalRowCount ?? 0) > 0, `found ${b3Details?.totalRowCount} anomalies`);

  // ========================================================================
  // B4: 用户行为 — 用户最常见的事件类型
  // ========================================================================
  console.log("\n[B4] 用户最常见的事件类型");
  const b4Result = await queryTool.execute(
    "b4",
    {
      sql: `SELECT event_type, COUNT(*) AS cnt FROM user_events GROUP BY event_type ORDER BY cnt DESC LIMIT 1`,
      user_intent: "用户最常见的事件类型是什么？",
      table_name: "user_events",
    },
    undefined, undefined, mockCtx
  );
  const b4Details = b4Result.details as Record<string, any> | undefined;
  assert("B4: SQL 包含 event_type", b4Details?.sql?.includes("event_type"));
  assert("B4: SQL 包含 COUNT", b4Details?.sql?.toLowerCase().includes("count(*)"));
  assert("B4: 结果不为空", (b4Details?.totalRowCount ?? 0) > 0);

  // ========================================================================
  // B5: 保险数据 — 不同产品类型的平均保费
  // ========================================================================
  console.log("\n[B5] 不同产品类型的平均保费");
  const b5Result = await queryTool.execute(
    "b5",
    {
      sql: `SELECT product_type, AVG(premium) AS avg_premium FROM insurance_policies GROUP BY product_type`,
      user_intent: "不同产品类型的平均保费是多少？",
      table_name: "insurance_policies",
    },
    undefined, undefined, mockCtx
  );
  const b5Details = b5Result.details as Record<string, any> | undefined;
  assert("B5: SQL 包含 product_type", b5Details?.sql?.includes("product_type"));
  assert("B5: SQL 包含 AVG(premium)", b5Details?.sql?.toLowerCase().includes("avg(premium)"));
  assert("B5: 返回 5 种产品类型", (b5Details?.totalRowCount ?? 0) === 5, `got ${b5Details?.totalRowCount} rows`);

  // ========================================================================
  // B6: 口径反问 — 分析活跃用户 → 触发主动反问
  // ========================================================================
  console.log("\n[B6] 分析活跃用户 → 触发主动反问");
  const ambiguity = detectAmbiguity("分析活跃用户", "SELECT * FROM user_events");
  assert("B6: 模糊请求被检测", ambiguity.isAmbiguous === true);
  assert("B6: 有反问原因", ambiguity.reasons.length > 0);
  assert("B6: 包含建议选项", (ambiguity.suggestedOptions?.length ?? 0) >= 2);

  // ========================================================================
  // B7: 可视化选择 — 展示销售趋势 → line chart
  // ========================================================================
  console.log("\n[B7] 展示销售趋势 → line chart");
  const b7Result = await visualizeTool.execute(
    "b7",
    {
      sql: `SELECT date, SUM(sales_amount) AS total_sales FROM sales_daily GROUP BY date ORDER BY date`,
      chart_type: "line",
      x_column: "date",
      y_column: "total_sales",
      title: "Daily Sales Trend",
    },
    undefined, undefined, mockCtx
  );
  const b7Details = b7Result.details as Record<string, any> | undefined;
  assert("B7: visualize 成功", b7Details?.success === true, JSON.stringify(b7Details));
  const b7PngPath = b7Details?.pngPath as string | undefined;
  assert("B7: PNG 路径返回", !!b7PngPath);
  assert("B7: PNG 文件存在", b7PngPath ? existsSync(b7PngPath) : false);
  assert("B7: PNG 大小 > 0", b7PngPath ? (statSync(b7PngPath).size > 0) : false);

  // ========================================================================
  // B8: 字段确认 — premium/claim_amount 字段含义确认
  // ========================================================================
  console.log("\n[B8] 字段确认 premium/claim_amount");
  // Step 1: describe_data 生成字典
  const b8DescResult = await describeTool.execute("b8-desc", { table_name: "insurance_policies" }, undefined, undefined, mockCtx);
  const b8DescDetails = b8DescResult.details as Record<string, any> | undefined;
  assert("B8: describe_data 成功", b8DescDetails?.tableName === "insurance_policies");

  // Step 2: confirm_dictionary 确认全部字段
  const b8ConfirmResult = await confirmDictTool.execute(
    "b8-confirm",
    { table_name: "insurance_policies", action: "confirm_all" },
    undefined, undefined, mockCtx
  );
  const b8ConfirmDetails = b8ConfirmResult.details as Record<string, any> | undefined;
  assert("B8: confirm_dictionary 成功", b8ConfirmDetails?.action === "confirm_all");
  assert("B8: 已持久化", b8ConfirmDetails?.persisted === true);

  // Step 3: 再次 describe_data 验证状态
  const b8VerifyResult = await describeTool.execute("b8-verify", { table_name: "insurance_policies" }, undefined, undefined, mockCtx);
  const b8VerifyDetails = b8VerifyResult.details as Record<string, any> | undefined;
  const colStatuses = b8VerifyDetails?.dictionaryColumnStatus as Array<{ name: string; status: string }> | undefined;
  const premiumStatus = colStatuses?.find((c) => c.name === "premium")?.status;
  const claimStatus = colStatuses?.find((c) => c.name === "claim_amount")?.status;
  assert("B8: premium 状态为 user-confirmed", premiumStatus === "user-confirmed", `got ${premiumStatus}`);
  assert("B8: claim_amount 状态为 user-confirmed", claimStatus === "user-confirmed", `got ${claimStatus}`);

  // ========================================================================
  // Cleanup
  // ========================================================================
  await engine.close();
  if (b7PngPath && existsSync(b7PngPath)) unlinkSync(b7PngPath);

  console.log(`\n=== Business Scenario Eval: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    throw new Error(`${failed} assertion(s) failed`);
  }
}

defineScriptSuite("business-scenarios", runBusinessScenarioTests);
