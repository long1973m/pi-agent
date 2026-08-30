/**
 * Pi Data Agent Extension
 *
 * Phase 1 集成入口：
 * - 初始化 PersistenceManager、SecurityChecker、DuckDBEngine
 * - session_start 时恢复 session 状态、连接 DuckDB
 * - session_shutdown 时保存 session 状态、关闭 DuckDB
 * - before_agent_start 注入数据上下文到 system prompt
 */

import type {
  ExtensionFactory,
  ExtensionAPI,
  ExtensionContext,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  SessionStartEvent,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

import { loadConfig, toSecurityConfig, ensureUploadsDir } from "./config.js";
import { PersistenceManager } from "./persistence.js";
import { SecurityChecker } from "./security.js";
import { createHash } from "node:crypto";
import { DuckDBEngine } from "./engine/duckdb.js";
import { PythonStatelessEngine } from "./engine/python-stateless.js";
import { createLogger, setLoggerDebug } from "./utils/logger.js";
import { runEnvCheck, formatWelcomeMessage } from "./utils/env-check.js";
import { createLoadDataTool } from "./tools/load-data.js";
import { createDescribeDataTool } from "./tools/describe-data.js";
import { createQueryDataTool } from "./tools/query-data.js";
import { createTransformDataTool } from "./tools/transform-data.js";
import { createListDatasetsTool } from "./tools/list-datasets.js";
import { createAskClarificationTool } from "./tools/ask-clarification.js";
import { createExportResultTool } from "./tools/export-result.js";
import { createVisualizeTool } from "./tools/visualize.js";
import { createShowImageTool } from "./tools/show-image.js";
import { createConnectDatabaseTool } from "./tools/connect-database.js";
import { createConfirmDictionaryTool } from "./tools/confirm-dictionary.js";
import { createGenerateReportTool } from "./tools/generate-report.js";
import { createGenerateSessionReportTool } from "./tools/generate-session-report.js";
import type { ToolContext } from "./tools/tool-context.js";
import { DataDictionaryManager } from "./hooks/data-dictionary.js";
import { QueryMemoryManager } from "./hooks/query-memory.js";
import { createActiveQuestioningHandler } from "./hooks/active-questioning.js";
import { AuditLogManager } from "./audit-log.js";
import { TableCardStore } from "./table-cards/store.js";
import { renderNavContext, truncateToBudget, QUERY_MEMORY_CHAR_BUDGET, CALIBER_CHAR_BUDGET } from "./navigation/nav-context.js";
import type { NavCardInfo } from "./navigation/nav-context.js";
import { listActiveMetricDefinitions } from "./metrics/metric-definitions.js";
import { createGetTableCardTool } from "./tools/get-table-card.js";
import { generateDatasetFingerprintSync } from "./utils/dataset-fingerprint.js";
import { startDashboard, stopDashboard, stopAllDashboards } from "./dashboard/lifecycle.js";
import { createDashboardServer } from "./dashboard/server.js";
import { openBrowser } from "./utils/open-browser.js";
import { generateAnalysisReport } from "./report/analysis/generate-analysis-report.js";
import { ReportIndexService } from "./dashboard/services/report-index.js";
import { callLLM, resolveLLMConfig } from "./llm/call-llm.js";
import type { CallLLMOptions } from "./llm/call-llm.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Phase 1+3 运行时上下文 */
interface RuntimeContext {
  config: ReturnType<typeof loadConfig>;
  security: SecurityChecker;
  persistence: PersistenceManager;
  engine: DuckDBEngine | null;
  sessionData: Map<string, unknown>;
  dataDictionary: DataDictionaryManager;
  queryMemory: QueryMemoryManager;
  /** v0.10 A-3: 表卡片存储（与 Dashboard 共用 .pi-data-agent/table-cards.json） */
  tableCards: TableCardStore;
  auditLog: AuditLogManager;
  /** LLM 调用函数（session_start 时从 ctx.model 初始化） */
  callLLM?: (prompt: string, systemPrompt?: string) => Promise<string>;
}

const factory: ExtensionFactory = async (pi: ExtensionAPI) => {
  let runtime: RuntimeContext | null = null;

  // v0.9 A-4: 日志分级 — 调试日志默认静默（PI_DATA_AGENT_DEBUG=1 或 config.debug 开启）
  const logger = createLogger("index");

  // ========================================================================
  // Session 生命周期
  // ========================================================================

  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    logger.debug("Event: session_start, reason:", event.reason);

    // 1. 加载配置
    const config = loadConfig({ cwd: ctx.cwd });
    // v0.9 A-4: config.debug（含 env PI_DATA_AGENT_DEBUG）合并进 logger 开关
    setLoggerDebug(config.debug);
    logger.debug(`Config loaded: cwd=${config.cwd}`);

    // 1.5 确保上传目录存在
    ensureUploadsDir(config);
    logger.debug(`Uploads dir ready: ${config.uploadsDir}`);

    // 2. 初始化持久化管理器
    const persistence = new PersistenceManager(config.globalConfigDir, config.projectConfigDir);

    // 3. 初始化安全层
    const security = new SecurityChecker(toSecurityConfig(config));

    // 4. 初始化 DuckDB 引擎
    let engine: DuckDBEngine | null = null;
    try {
      engine = new DuckDBEngine({
        dbPath: config.dbPath,
        previewLimit: config.previewLimit,
        outputDir: config.outputDir,
      });
      await engine.init();
      logger.debug(`DuckDB connected: ${config.dbPath}`);
    } catch (err) {
      logger.error("DuckDB init failed:", err);
      engine = null;
    }

    // 5. 初始化 Phase 3 管理器
    const dataDictionary = new DataDictionaryManager(persistence);
    // F-1（v0.11）：maxQueryMemoryEntries 配置传入生效（此前构造函数固定 5 未消费配置）
    const queryMemory = new QueryMemoryManager(persistence, config.maxQueryMemoryEntries);
    logger.debug("Phase 3 managers initialized");

    // 5.2 v0.10 A-3: 初始化表卡片存储
    const tableCards = new TableCardStore(config.projectConfigDir);

    // 5.5 初始化 Audit Log
    const auditLog = new AuditLogManager(config.projectConfigDir);
    logger.debug("Audit log initialized");

    // 6. 恢复 session 状态
    const sessionState = persistence.restoreSessionState();
    logger.debug(`Session state restored: dictionary=${sessionState.dataDictionary?.length ?? 0}, memory=${sessionState.queryMemory?.entries.length ?? 0}`);

    // 7. 读取已有 session entries（S0.1 验证点 6）
    try {
      const branch = ctx.sessionManager.getBranch();
      logger.debug(`sessionManager.getBranch() returned ${branch.length} entries`);
    } catch (err) {
      logger.debug("sessionManager.getBranch() error:", err);
    }

    // 8. 构建运行时上下文
    runtime = {
      config,
      security,
      persistence,
      engine,
      sessionData: new Map(),
      dataDictionary,
      queryMemory,
      tableCards,
      auditLog,
    };
    runtime.sessionData.set("session_start_time", new Date().toISOString());
    runtime.sessionData.set("cwd", ctx.cwd);
    runtime.sessionData.set("reason", event.reason);

    // 8.5 初始化 LLM 调用函数
    const llmConfig = await resolveLLMConfig(ctx);
    if (llmConfig) {
      runtime.callLLM = (prompt: string, systemPrompt?: string) =>
        callLLM(prompt, llmConfig, systemPrompt).then((r) => r.content);
      logger.debug(`LLM configured: ${llmConfig.modelId} via ${llmConfig.api}`);
    } else {
      logger.debug("LLM not configured (no model or API key)");
    }

    // 9. v0.9 A-3: 环境自检 + 欢迎引导（异步执行，不阻塞 session_start）
    const rt = runtime;
    void (async () => {
      try {
        // Python 探测脚本路径（src/ 与 dist/ 相对 scripts/ 的层级一致）
        const scriptDir = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
        const pythonEngine = new PythonStatelessEngine({
          scriptPath: join(scriptDir, "generate_chart.py"),
        });
        const envCheck = await runEnvCheck({
          engine: rt.engine,
          llmConfigured: !!rt.callLLM,
          checkPython: () => pythonEngine.checkAvailability(),
        });
        rt.sessionData.set("env_check", envCheck);

        // 输出通道：优先 ctx.ui.notify，回退单条 logger.info
        const lines = formatWelcomeMessage(envCheck);
        if (ctx.ui?.notify) {
          ctx.ui.notify(lines.join("\n"), "info");
        } else {
          for (const line of lines) logger.info(line);
        }
      } catch (err) {
        logger.debug("Env check failed:", err);
      }
    })();
  });

  pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx: ExtensionContext) => {
    logger.debug("Event: session_shutdown, reason:", event.reason);

    if (!runtime) return;

    // 1. 保存内存中的数据字典和查询记忆到 project 层
    try {
      const dataDictionaryEntries = runtime.dataDictionary?.getAllDictionaries() ?? [];
      runtime.persistence.saveDataDictionary(dataDictionaryEntries, "project");
      const queryMemory = runtime.queryMemory?.getMemory() ?? {maxEntries: 5, entries: []};
      runtime.persistence.saveQueryMemory(queryMemory, "project");
      runtime.persistence.saveSessionState({ dataDictionary: dataDictionaryEntries, queryMemory });
      logger.debug("Session state saved successfully");
    } catch (err) {
      logger.error("Failed to save session state:", err instanceof Error ? err.message : String(err));
    }

    // 2. 关闭 DuckDB
    if (runtime.engine) {
      try {
        await runtime.engine.close();
        logger.debug("DuckDB disconnected");
      } catch (err) {
        logger.error("DuckDB close failed:", err);
      }
    }

    // 3. 停止 Dashboard
    try {
      await stopAllDashboards();
      logger.debug("Dashboard stopped");
    } catch (err) {
      logger.error("Dashboard stop failed:", err);
    }

    // 4. 清理（会话时长统计归入 debug）
    const startTime = runtime.sessionData.get("session_start_time");
    const endTime = new Date().toISOString();
    logger.debug(`Session duration: ${startTime} -> ${endTime}`);
    runtime = null;
  });

  // ========================================================================
  // before_agent_start — 注入数据上下文
  // ========================================================================

  pi.on("before_agent_start", async (
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext
  ): Promise<BeforeAgentStartEventResult> => {
    logger.debug("Event: before_agent_start");

    // ======================================================================
    // v0.10 A-4: L0 导航层（渐进式披露：常驻地图 ≤400 token + get_table_card 下钻）
    // 替换原 "Current Data Context" 段；查询记忆/口径注入保留但各加预算上限。
    // ======================================================================

    let navContext = "";
    if (runtime?.engine) {
      const engine = runtime.engine;
      try {
        const tables = await engine.getTables();
        if (tables.length > 0) {
          const overviews = await Promise.all(
            tables.map((t: string) => engine.getTableOverview(t).catch(() => null))
          );
          const navTables = overviews
            .filter((o): o is NonNullable<typeof o> => o !== null)
            .map((o: NonNullable<(typeof overviews)[number]>) => ({
              name: o.name,
              rowCount: o.rowCount,
              columnCount: o.columnCount,
            }));

          // 表卡片 → 导航行内容（无卡片退化为行列数）
          const cards = new Map<string, NavCardInfo>();
          if (runtime.tableCards) {
            for (const card of runtime.tableCards.list().cards) {
              cards.set(card.tableName, { summary: card.summary, tags: card.tags, stale: card.stale });
            }
          }

          // pinned 高频/固定分析（A-5）与指标定义全量注入（A-6）
          const pinned = runtime.queryMemory?.getPinnedEntries(10) ?? [];
          const metrics = runtime.config
            ? listActiveMetricDefinitions(runtime.config.projectConfigDir).map((m) => ({
                name: m.name,
                definition: m.definition,
                updatedAt: m.updatedAt,
              }))
            : [];

          navContext = renderNavContext({ tables: navTables, cards, pinned, metrics });
        }
      } catch (err) {
        logger.debug("Failed to build navigation context:", err);
      }
    }

    // Phase 2.5: 计算全局 schema fingerprint 并设置给 queryMemory
    const dd = runtime?.dataDictionary;
    const qm = runtime?.queryMemory;
    const eng = runtime?.engine;
    if (qm && dd && eng) {
      try {
        const dictionaries = dd.getAllDictionaries();
        if (dictionaries.length > 0) {
          const fingerprints = await Promise.all(
            dictionaries.map(async (d) => {
              const fp = await dd.computeFingerprint(d.tableName, eng);
              return `${d.tableName}:${fp}`;
            })
          );
          const globalFingerprint = createHash("md5").update(fingerprints.join("|")).digest("hex");
          qm.setDatasetFingerprint(globalFingerprint);
        }
      } catch (err) {
        logger.debug("Failed to compute schema fingerprint:", err);
      }
    }

    // Phase 3: 查询记忆注入（v0.10 A-4：保留但加预算上限，超限截断）
    let queryMemoryContext = "";
    if (runtime?.queryMemory) {
      queryMemoryContext = truncateToBudget(
        runtime.queryMemory.generatePromptInjection(),
        QUERY_MEMORY_CHAR_BUDGET,
      );
    }

    // Phase 4: 口径记忆注入（agent.md 历史口径；v0.10 A-4：加预算上限，超限截断）
    let caliberContext = "";
    if (runtime?.persistence) {
      const calibers = runtime.persistence.getRecentCalibers(10);
      if (calibers.length > 0) {
        caliberContext =
          "\n\n## User Confirmed Calibers\n\n" +
          "The user has previously confirmed the following analysis calibers. " +
          "Do NOT re-ask about these questions — apply the confirmed assumption directly.\n\n" +
          calibers
            .map((c) => `- **Q: ${c.question}** → ${c.definition} (${c.appliedAssumption}) [${c.confirmedAt}]`)
            .join("\n");
        caliberContext = truncateToBudget(caliberContext, CALIBER_CHAR_BUDGET);
      }
    }

    // v0.7: 字典状态权重规则
    const dictionaryStatusRules =
      "\n\n### Data Dictionary Status Weights\n"
      + "When referencing field meanings from the data dictionary, respect the following priority:\n"
      + "- [已修正] user-corrected: Highest reliability. Always use userMeaning.\n"
      + "- [已确认] user-confirmed: High reliability. Use userMeaning if available, else inferredMeaning.\n"
      + "- [AI推测] ai-guessed: Medium reliability. Can assist understanding but MUST mark as unconfirmed in outputs.\n"
      + "- [不确定] uncertain: Low reliability. MUST NOT be used as definitive business semantics. Ask user to clarify when critical.\n"
      + "- When generating formal reports (Analysis Reports), fields with unconfirmed status must be noted in the limitations section.\n";

    // v0.4: Session Report 触发规则
    const sessionReportRules =
      "\n\n### Session Report Rules\n"
      + "- After completing a full analysis task (e.g., user asked a data question and you provided a complete answer with SQL + results + charts), proactively call generate_session_report to generate a visual session report.\n"
      + "- When the user explicitly says \"生成报告\" / \"给我看看结果\" / \"整理分析结果\" / \"generate report\", call generate_session_report.\n"
      + "- Do NOT call generate_session_report after every single tool call — only after a complete analysis cycle (>= 2 tool calls have been made AND the user's question has been answered).\n"
      + "- For data-specific reports (focused on a single query's results), use generate_report instead.";

    return {
      systemPrompt: event.systemPrompt
        + "\n\n## Pi Data Agent Extension\n\n"
        + "You are a data analysis assistant powered by DuckDB. "
        + "You can load CSV files, query data with SQL, describe datasets, transform data, export results, and list loaded datasets. "
        + "Always use the provided tools rather than writing raw SQL in responses."
        + "\n\n### Important Rules for query_data tool\n"
        + "- When calling query_data, you MUST provide both `sql` and `user_intent`.\n"
        + "- `user_intent` must be the user's original natural language question. Never leave it empty.\n"
        + "- If the user's request is open-ended (e.g., 'analyze these data', 'take a look', 'what do you see'), "
        + "DO NOT call query_data directly. Instead, call ask_clarification FIRST to clarify the analysis direction.\n"
        + "- Only call query_data when the user's intent is clear and specific."
        + "\n\n### Table Knowledge Rule\n"
        + "- Before writing SQL, if you are unsure about a table's purpose, boundaries, or field meanings, "
        + "call get_table_card with the table name FIRST. Do not guess table contents."
        + navContext
        + queryMemoryContext
        + caliberContext
        + dictionaryStatusRules
        + sessionReportRules,
    };
  });

  // ========================================================================
  // Phase 2 核心工具注册
  // ========================================================================

  const getToolContext = (): ToolContext | null => {
    if (!runtime) return null;
    return {
      engine: runtime.engine,
      security: runtime.security,
      persistence: runtime.persistence,
      cwd: runtime.config.cwd,
      config: runtime.config,
      dataDictionary: runtime.dataDictionary,
      queryMemory: runtime.queryMemory,
      tableCards: runtime.tableCards,
      callLLM: runtime.callLLM,
    };
  };

  const toolParams = { getRuntime: getToolContext };

  pi.registerTool(createLoadDataTool(toolParams));
  pi.registerTool(createDescribeDataTool(toolParams));
  pi.registerTool(createQueryDataTool(toolParams));
  pi.registerTool(createTransformDataTool(toolParams));
  pi.registerTool(createListDatasetsTool(toolParams));
  pi.registerTool(createAskClarificationTool(toolParams));
  pi.registerTool(createExportResultTool(toolParams));
  pi.registerTool(createVisualizeTool(toolParams));
  pi.registerTool(createShowImageTool(toolParams));
  pi.registerTool(createConnectDatabaseTool(toolParams));
  pi.registerTool(createConfirmDictionaryTool(toolParams));
  pi.registerTool(createGenerateReportTool(toolParams));
  pi.registerTool(createGenerateSessionReportTool(toolParams));
  // v0.10 A-4: L1 按需取用层——表卡片/相关指标口径/字段业务含义三源聚合
  pi.registerTool(createGetTableCardTool(toolParams));
  logger.debug("Registered 14 tools: load_data, describe_data, query_data, transform_data, list_datasets, ask_clarification, export_result, visualize, show_image, connect_database, confirm_dictionary, generate_report, generate_session_report, get_table_card");

  // ========================================================================
  // Phase 3: tool_call Hook（主动反问拦截）
  // ========================================================================

  pi.on("tool_call", async (event, ctx) => {
    if (!runtime) return undefined;
    const handler = createActiveQuestioningHandler({
      dictionaryManager: runtime.dataDictionary,
      getEngine: () => runtime?.engine ?? null,
    });
    return handler(event, ctx);
  });
  logger.debug("Registered active-questioning hook");

  // ========================================================================
  // S5.3: Audit Log（tool_execution_start / tool_execution_end）
  // ========================================================================

  pi.on("tool_execution_start", (event) => {
    runtime?.auditLog?.recordStart(event.toolCallId, event.toolName, event.args as Record<string, unknown>);
  });

  pi.on("tool_execution_end", (event) => {
    runtime?.auditLog?.recordEnd({
      toolCallId: event.toolCallId,
      result: event.result,
      isError: event.isError,
    });
  });
  logger.debug("Registered audit log hooks");

  // ========================================================================
  // /dashboard — 打开本地 Dashboard
  // ========================================================================

  pi.registerCommand("dashboard", {
    description: "Open the local web Dashboard for browsing analysis reports, managing data dictionary, and more",
    handler: async (_args, _ctx) => {
      if (!runtime) {
        _ctx.ui?.notify("Dashboard 需要在 session 启动后使用。", "error");
        return;
      }

      try {
        const rt = runtime;

        // 先停掉旧实例（避免复用缓存了旧代码的进程）
        await stopDashboard(rt.config.projectConfigDir);

        const handle = await startDashboard(
          {
            projectDir: rt.config.projectConfigDir,
            openBrowser: true,
          },
          async (port, writeToken) => {
            return createDashboardServer(port, writeToken, {
              projectDir: rt.config.projectConfigDir,
              cwd: rt.config.cwd,
              engine: rt.engine,
              dictionaryManager: rt.dataDictionary,
              queryMemory: rt.queryMemory,
              callLLM: rt.callLLM,
              uploadsDir: rt.config.uploadsDir,
            });
          }
        );

        // 打开浏览器
        await openBrowser(handle.url);

        _ctx.ui?.notify(`Dashboard 已启动: ${handle.url}`, "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        _ctx.ui?.notify(`Dashboard 启动失败: ${msg}`, "error");
      }
    },
  });
  logger.debug("Registered /dashboard command");

  // ========================================================================
  // /report — 基于当前分析生成正式报告
  // ========================================================================

  pi.registerCommand("report", {
    description:
      "基于当前分析生成正式报告（支持 /report executive 或 /report detailed）",
    getArgumentCompletions(argumentPrefix: string) {
      return ["executive", "detailed"]
        .filter((v) => v.startsWith(argumentPrefix))
        .map((v) => ({ value: v, label: v, description: v === "executive" ? "简版报告（3 条核心结论）" : "详细报告（完整分析）" }));
    },
    handler: async (args, ctx) => {
      if (!runtime) {
        ctx.ui?.notify("报告生成需要在 session 启动后使用。", "error");
        return;
      }

      const mode = args === "executive" ? "executive" as const : "detailed" as const;

      ctx.ui?.notify(`正在生成${mode === "executive" ? "简版" : "详细"}分析报告...`, "info");

      try {
        const rt = runtime;
        const sessionEntries = ctx.sessionManager.getBranch();

        if (sessionEntries.length === 0) {
          ctx.ui?.notify("当前会话没有分析内容，无法生成报告。", "error");
          return;
        }

        // 构建 generateAnalysisReport 所需参数
        const sessionId = rt.sessionData.get("session_start_time") as string || `session-${Date.now()}`;
        const reportsDir = join(rt.config.projectConfigDir, "reports");
        const dictionaryEntries = rt.persistence.loadMergedDataDictionary();
        const dictArray = Array.from(dictionaryEntries.values());
        const calibers = rt.persistence.getRecentCalibers(50);

        // 从查询记忆获取相关查询
        const queryMemoryEntries = rt.queryMemory.recallRelevantQueries(20);

        // 找到最新的 session report ID
        const reportService = new ReportIndexService(rt.config.projectConfigDir);
        const sessionReports = reportService.listByType("session");
        const sourceSessionReportId = sessionReports.length > 0 ? sessionReports[0].id : "";

        const result = await generateAnalysisReport({
          sessionEntries: sessionEntries as any[],
          sessionId,
          reportMode: mode,
          dictionaryEntries: dictArray,
          calibers: calibers.map((c) => ({
            id: c.id,
            question: c.question,
            definition: c.definition,
            confirmedAt: c.confirmedAt,
          })),
          queryMemory: queryMemoryEntries.map((q) => ({
            id: q.id,
            naturalLanguageQuery: q.naturalLanguageQuery,
            sql: q.sql,
            timestamp: q.timestamp,
            resultSummary: q.resultSummary,
          })),
          reportsDir,
          sourceSessionReportId,
          callModel: rt.callLLM
            ? (prompt: string, _responseFormat?: object) => rt.callLLM!(prompt)
            : undefined,
        });

        if (result.success && result.reportPath) {
          // 从 evidence 中提取 datasets 和 charts
          const ev = result.evidence;
          const datasets = ev?.scope?.datasets ?? [];
          const charts = (ev?.charts ?? []).map((c) => ({
            id: c.id,
            title: c.title,
            generatedAt: c.generatedAt,
            dataset: c.dataset,
          }));

          // 注册到 manifest
          reportService.addReport({
            id: result.reportId!,
            type: "analysis",
            title: "分析报告",
            summary: `基于会话分析的${mode === "executive" ? "简版" : "详细"}报告`,
            createdAt: new Date().toISOString(),
            file: result.reportPath.replace(reportsDir + "/", ""),
            datasets,
            charts,
            reportMode: mode,
            sourceSessionId: sessionId,
            sourceSessionReportId,
            evidenceCoverage: result.qualityGate?.coverage ?? 0,
            evidencePath: result.evidencePath
              ? result.evidencePath.replace(reportsDir + "/", "")
              : undefined,
          });

          await openBrowser(result.reportPath);
          ctx.ui?.notify(`分析报告已生成并打开。`, "info");
        } else {
          const errorDetail = result.missingItems?.length
            ? `证据不足：${result.missingItems.join("; ")}`
            : result.error || "未知错误";
          ctx.ui?.notify(`报告生成失败：${errorDetail}`, "error");
        }
      } catch (err) {
        ctx.ui?.notify(
          `报告生成异常：${err instanceof Error ? err.message : String(err)}`,
          "error"
        );
      }
    },
  });
  logger.debug("Registered /report command");
};

export default factory;
