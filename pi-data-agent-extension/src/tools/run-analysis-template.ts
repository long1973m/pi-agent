/**
 * v0.13 TPL-1 — run_analysis_template：PM 分析模板工具（funnel / cohort）
 *
 * 骨架职责（spec §4.1）：
 * - 参数校验（TemplateParamError → 结构化错误 + 修正指引）
 * - 字典联动：映射列/条件触及 uncertain 状态列 → block（fail-closed）；
 *   ai-guessed → 结果携带 dictionary_flags（⚠ 不阻断）
 * - 执行复用：security.checkSql → executeWithRecovery(engine.executeQueryWithLimit)，
 *   与 query_data 同一执行通道，不开新口子
 * - 统计确定性：数值全部由 analysis/pm-templates.ts 计算，本工具只装配与解释引导
 * - 审计：AUDIT_TOOLS + buildSummary case（audit-log.ts）
 *
 * ab_test 模板在阶段三（AB-1）按同一骨架扩展进 template 枚举。
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ToolRegisterParams } from "./tool-context.js";
import type { ColumnSemanticStatus, QueryResult } from "../types.js";
import {
  TemplateParamError,
  validateFunnelParams,
  validateCohortParams,
  validateAbTestParams,
  buildFunnelSql,
  buildCohortSql,
  buildAbTestOverallSql,
  buildAbTestSegmentSql,
  computeFunnelResult,
  computeCohortResult,
  computeAbTestResult,
  funnelMethodNotes,
  cohortMethodNotes,
  abTestMethodNotes,
  FUNNEL_CHART_SUGGESTION,
  COHORT_CHART_SUGGESTION,
  AB_TEST_CHART_SUGGESTION,
  type TemplateKind,
  type AbTestParams,
} from "../analysis/pm-templates.js";
import { executeWithRecovery, recoveryResultToToolResult } from "../error-recovery.js";

const RunAnalysisTemplateParams = Type.Object({
  template: Type.String({
    description: "分析模板：funnel（状态漏斗）| cohort（留存分群）。ab_test 将在后续版本提供。",
  }),
  table: Type.String({ description: "已登记的数据集表名（见 list_datasets；远程 attached 表需先物化或导入本地）" }),
  params: Type.Object({
    // funnel
    steps: Type.Optional(Type.Array(
      Type.Object({
        label: Type.Optional(Type.String({ description: "步骤名（如「访问」），缺省为 step_N" })),
        condition: Type.String({ description: "WHERE 布尔条件（该表列上的 SQL 表达式）" }),
      }),
      { description: "funnel：2~8 步，数组序即漏斗序" }
    )),
    user_key: Type.Optional(Type.String({ description: "去重键列（user_id / order_id）" })),
    time_column: Type.Optional(Type.String({ description: "funnel 可选：与 window_days 成对的时间列" })),
    window_days: Type.Optional(Type.Number({ description: "funnel 可选：窗口 = 数据最新时间往前 N 天（1~3650）" })),
    // cohort
    activity_time: Type.Optional(Type.String({ description: "cohort：活动时间列（DATE/TIMESTAMP）" })),
    period: Type.Optional(Type.String({ description: "cohort：week | month（默认 month 需显式传入其一）" })),
    activity_condition: Type.Optional(Type.String({ description: "cohort 可选：活动条件（排除噪声行为，如 \"kind = 'purchase'\"）" })),
    lookback: Type.Optional(Type.Number({ description: "cohort 可选：期数偏移上限 1~24（默认 12）" })),
    // ab_test
    variant_column: Type.Optional(Type.String({ description: "ab_test：分组列（该列必须恰好有 2 个非空取值）" })),
    success_condition: Type.Optional(Type.String({ description: "ab_test：转化布尔条件（该表列上的 SQL 表达式）" })),
    unit: Type.Optional(Type.String({ description: "ab_test：去重粒度列（如 user_id，同一 unit 多行只计一次）" })),
    segment_columns: Type.Optional(Type.Array(Type.String(), { description: "ab_test 可选：辛普森扫描维度列（0~3 个）" })),
    alpha: Type.Optional(Type.Number({ description: "ab_test 可选：显著性水平 0~1（默认 0.05）" })),
  }),
  user_intent: Type.String({
    description: "用户原始自然语言问题，必填。用于审计与解释口径。",
  }),
});

/** 组装 funnel 的返回文本与结构化结果 */
function funnelOutcome(
  table: string,
  params: ReturnType<typeof validateFunnelParams>,
  sql: string,
  row: Record<string, unknown>,
  dictionaryFlags: { aiGuessedColumns: string[]; uncertainColumns: string[] },
): { text: string; details: Record<string, unknown> } {
  const result = computeFunnelResult(params, row);
  const lines: string[] = [];
  for (const s of result.steps) {
    const conv =
      s.stepConversionPct === null
        ? `${s.users} 人`
        : `${s.users} 人（步转化 ${s.stepConversionPct}%，累计 ${s.totalConversionPct}%）`;
    lines.push(`${s.step}. ${s.label}: ${conv}`);
  }
  const mappingText = `user_key=${params.user_key}` +
    (params.time_column ? ` | 窗口=${params.time_column} 最近 ${params.window_days} 天` : " | 窗口=全表");

  const text = [
    `📊 funnel 漏斗分析 — 表 ${table}`,
    `映射：${mappingText}`,
    ``,
    ...lines,
    result.warnings.length > 0 ? `\n⚠ 提示：\n${result.warnings.map((w) => `  • ${w}`).join("\n")}` : "",
    `\n📌 ${funnelMethodNotes(params)}`,
    `\n📈 图表建议：${FUNNEL_CHART_SUGGESTION}`,
  ].filter((l) => l !== "").join("\n");

  return {
    text,
    details: {
      toolName: "run_analysis_template",
      template: "funnel",
      table,
      sql,
      mapping: { user_key: params.user_key, time_column: params.time_column ?? null, window_days: params.window_days ?? null },
      steps: result.steps,
      warnings: result.warnings,
      methodNotes: funnelMethodNotes(params),
      chartSuggestion: FUNNEL_CHART_SUGGESTION,
      dictionaryFlags,
    },
  };
}

/** 组装 cohort 的返回文本与结构化结果 */
function cohortOutcome(
  table: string,
  params: ReturnType<typeof validateCohortParams>,
  sql: string,
  rows: Array<Record<string, unknown>>,
  dictionaryFlags: { aiGuessedColumns: string[]; uncertainColumns: string[] },
): { text: string; details: Record<string, unknown> } {
  const result = computeCohortResult(rows);
  const cohortLines = result.cohorts.map((c) => {
    const offsets = c.offsets.map((o) => `offset${o.offset} ${o.retentionPct}%`).join(" | ");
    return `cohort ${c.cohort}（规模 ${c.size}）: ${offsets}`;
  });
  const avgLine = result.averageRetentionPct.map((a) => `offset${a.offset} ${a.avgPct}%`).join(" | ");
  const mappingText = `user_key=${params.user_key} | activity_time=${params.activity_time} | period=${params.period} | lookback=${params.lookback}` +
    (params.activity_condition ? ` | 活动条件: ${params.activity_condition}` : "");

  const text = [
    `📊 cohort 留存分析 — 表 ${table}（${params.period === "month" ? "月度" : "周度"}）`,
    `映射：${mappingText}`,
    ``,
    ...cohortLines,
    result.averageRetentionPct.length > 0 ? `\n平均留存（各群简单平均）: ${avgLine}` : "",
    result.warnings.length > 0 ? `\n⚠ 提示：\n${result.warnings.map((w) => `  • ${w}`).join("\n")}` : "",
    `\n📌 ${cohortMethodNotes(params)}`,
    `\n📈 图表建议：${COHORT_CHART_SUGGESTION}`,
  ].filter((l) => l !== "").join("\n");

  return {
    text,
    details: {
      toolName: "run_analysis_template",
      template: "cohort",
      table,
      sql,
      mapping: {
        user_key: params.user_key,
        activity_time: params.activity_time,
        period: params.period,
        activity_condition: params.activity_condition ?? null,
        lookback: params.lookback,
      },
      cohorts: result.cohorts,
      averageRetentionPct: result.averageRetentionPct,
      warnings: result.warnings,
      methodNotes: cohortMethodNotes(params),
      chartSuggestion: COHORT_CHART_SUGGESTION,
      dictionaryFlags,
    },
  };
}

/** 组装 ab_test 的返回文本与结构化结果（AB-1：四项护栏全部确定性输出） */
function abTestOutcome(
  table: string,
  params: AbTestParams,
  sql: string,
  armRows: Array<Record<string, unknown>>,
  segmentResults: Array<{ column: string; rows: Array<Record<string, unknown>> }>,
  dictionaryFlags: { aiGuessedColumns: string[]; uncertainColumns: string[] },
): { text: string; details: Record<string, unknown> } {
  const result = computeAbTestResult(params, armRows, segmentResults);
  const [a1, a2] = result.arms;
  const armLines = result.arms.map(
    (a) => `  ${a.variant}: n=${a.n}, 转化 ${a.conv}, 比率 ${(a.rate * 100).toFixed(2)}%`
  );
  const verdict =
    result.z === null || result.p === null
      ? "无法检验（合并转化率退化，见提示）"
      : `z = ${result.z.toFixed(4)}, p = ${result.p.toFixed(5)}, α=${result.alpha} → ${result.significant ? "显著" : "不显著"}`;
  const effect =
    result.absDiffPct === null
      ? ""
      : `效应量：绝对差 ${result.absDiffPct >= 0 ? "+" : ""}${result.absDiffPct}pp；` +
        `相对 lift ${result.liftPct === null ? "—" : `${result.liftPct >= 0 ? "+" : ""}${result.liftPct}%`}（${a2.variant} 相对 ${a1.variant}）`;

  const text = [
    `📊 A/B 双比例检验 — 表 ${table}`,
    `映射：variant=${params.variant_column} | 转化条件: ${params.success_condition} | unit=${params.unit}` +
      (params.segment_columns.length > 0 ? ` | 辛普森扫描: ${params.segment_columns.join("、")}` : ""),
    ``,
    `臂（按 variant 字典序）:`,
    ...armLines,
    ``,
    `检验（双侧两比例 z，合并比例）: ${verdict}`,
    effect,
    result.simpsonFindings.length > 0
      ? `\n⚠ 辛普森发现：\n${result.simpsonFindings.map((f) => `  • ${f}`).join("\n")}`
      : "",
    result.warnings.length > 0 ? `\n⚠ 提示：\n${result.warnings.map((w) => `  • ${w}`).join("\n")}` : "",
    `\n📌 ${abTestMethodNotes(params)}`,
    `\n📈 图表建议：${AB_TEST_CHART_SUGGESTION}`,
  ].filter((l) => l !== "").join("\n");

  return {
    text,
    details: {
      toolName: "run_analysis_template",
      template: "ab_test",
      table,
      sql,
      mapping: {
        variant_column: params.variant_column,
        success_condition: params.success_condition,
        unit: params.unit,
        segment_columns: params.segment_columns,
        alpha: params.alpha,
      },
      arms: result.arms,
      z: result.z,
      p: result.p,
      pooled: result.pooled,
      significant: result.significant,
      betterArm: result.betterArm,
      absDiffPct: result.absDiffPct,
      liftPct: result.liftPct,
      warnings: result.warnings,
      simpsonFindings: result.simpsonFindings,
      methodNotes: abTestMethodNotes(params),
      chartSuggestion: AB_TEST_CHART_SUGGESTION,
      dictionaryFlags,
    },
  };
}

export function createRunAnalysisTemplateTool(params: ToolRegisterParams): ToolDefinition {  return {
    name: "run_analysis_template",
    label: "Run Analysis Template",
    description:
      "Run a parameterized PM analysis template with deterministic statistics: " +
      "funnel (stacked-condition status funnel), cohort (weekly/monthly retention), and ab_test " +
      "(two-proportion z-test with sample-size guardrails, Simpson's-paradox scan and effect sizes). " +
      "All numbers are computed deterministically — interpret the returned methodNotes, do NOT recompute statistics. " +
      "Conditions must reference the target table's columns; the table must be a registered local dataset. " +
      "For charts, call visualize afterwards using the chartSuggestion.",
    parameters: RunAnalysisTemplateParams,
    execute: async (
      _toolCallId: string,
      args: { template: string; table: string; params: Record<string, unknown>; user_intent: string },
      _signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      _ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const rt = params.getRuntime();
      if (!rt?.engine) {
        return {
          content: [{ type: "text", text: "Error: DuckDB engine not available." }],
          details: { toolName: "run_analysis_template", error: "engine not available" },
        };
      }
      if (!args.user_intent || args.user_intent.trim().length === 0) {
        return {
          content: [{ type: "text", text: "Error: user_intent is required and cannot be empty." }],
          details: { toolName: "run_analysis_template", error: "missing_user_intent" },
        };
      }

      const kind = args.template.trim().toLowerCase() as TemplateKind;
      if (kind !== "funnel" && kind !== "cohort" && kind !== "ab_test") {
        return {
          content: [{ type: "text", text: `Error: 未知模板 "${args.template}"。可用模板：funnel、cohort、ab_test。` }],
          details: { toolName: "run_analysis_template", error: "unknown_template", template: args.template },
        };
      }

      // 1. 表必须已登记（本地 main 库）
      let tables: string[];
      try {
        tables = await rt.engine.getTables();
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing tables: ${err}` }],
          details: { toolName: "run_analysis_template", error: String(err) },
        };
      }
      if (!tables.includes(args.table)) {
        return {
          content: [{
            type: "text",
            text: `Error: 表 "${args.table}" 未登记。当前可用：${tables.map((t) => `- ${t}`).join("\n") || "(none)"}。` +
              `远程 attached 表需先用 load_data 导出子集或等待物化能力（v0.14）。`,
          }],
          details: { toolName: "run_analysis_template", error: "table_not_registered", availableTables: tables },
        };
      }

      // 2. 参数校验（确定性模板函数内完成，非法即结构化错误）
      let validated:
        | ReturnType<typeof validateFunnelParams>
        | ReturnType<typeof validateCohortParams>
        | ReturnType<typeof validateAbTestParams>;
      try {
        validated =
          kind === "funnel"
            ? validateFunnelParams(args.params)
            : kind === "cohort"
              ? validateCohortParams(args.params)
              : validateAbTestParams(args.params);
      } catch (err) {
        if (err instanceof TemplateParamError) {
          return {
            content: [{ type: "text", text: `Error: 模板参数错误（${err.param}）：${err.message}` }],
            details: { toolName: "run_analysis_template", error: "invalid_params", param: err.param, message: err.message },
          };
        }
        throw err;
      }

      const funnelParams = kind === "funnel" ? (validated as ReturnType<typeof validateFunnelParams>) : null;
      const cohortParams = kind === "cohort" ? (validated as ReturnType<typeof validateCohortParams>) : null;
      const abParams = kind === "ab_test" ? (validated as ReturnType<typeof validateAbTestParams>) : null;

      // 2.5 映射列存在性预校验（spec §4.1 执行流第 1 步；比执行期 Binder Error 更早给出人话指引）
      const mappingColumns =
        kind === "funnel"
          ? [funnelParams!.user_key, ...(funnelParams!.time_column ? [funnelParams!.time_column] : [])]
          : kind === "cohort"
            ? [cohortParams!.user_key, cohortParams!.activity_time]
            : [abParams!.variant_column, abParams!.unit, ...abParams!.segment_columns];
      try {
        const schema = await rt.engine.getSchema(args.table);
        const columnNames = new Set(schema.map((c) => c.name));
        const missing = mappingColumns.filter((c) => !columnNames.has(c));
        if (missing.length > 0) {
          return {
            content: [{
              type: "text",
              text: `Error: 映射列不存在：${missing.join("、")}。该表可用列：${schema.map((c) => c.name).join("、")}。请先 describe_data 确认列名后重试。`,
            }],
            details: {
              toolName: "run_analysis_template",
              error: "missing_column",
              missingColumns: missing,
              availableColumns: schema.map((c) => c.name),
            },
          };
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error reading schema for "${args.table}": ${err}` }],
          details: { toolName: "run_analysis_template", error: String(err) },
        };
      }

      // 3. 生成 SQL（确定性；ab_test = 总体一条 + 每个分段列一条）
      const sqls =
        kind === "funnel"
          ? [buildFunnelSql(args.table, funnelParams!)]
          : kind === "cohort"
            ? [buildCohortSql(args.table, cohortParams!)]
            : [
                buildAbTestOverallSql(args.table, abParams!),
                ...abParams!.segment_columns.map((c) => buildAbTestSegmentSql(args.table, abParams!, c)),
              ];
      const sql = sqls[0];

      // 4. 字典联动（fail-closed：uncertain 列 → block；ai-guessed → 标记）
      const dictionaryFlags = { aiGuessedColumns: [] as string[], uncertainColumns: [] as string[] };
      try {
        // 只在完全没有字典时生成（已存在则只读缓存——避免覆盖用户已确认/已修正的标记）
        if (!rt.dataDictionary.hasDictionary(args.table)) {
          await rt.dataDictionary.ensureDictionary(args.table, rt.engine);
        }
        const uncertain = rt.dataDictionary.checkUncertainColumns(args.table, sqls.join(";\n"));
        if (uncertain.length > 0) {
          const names = [...new Set(uncertain.map((c) => c.name))].join("、");
          return {
            content: [{
              type: "text",
              text: `Error: 本模板涉及 uncertain 状态字段（${names}），语义未确认，已拒绝执行（fail-closed）。` +
                `请先用 confirm_dictionary 确认或修正这些字段的含义，再重试。`,
            }],
            details: {
              toolName: "run_analysis_template",
              error: "uncertain_columns_blocked",
              uncertainColumns: [...new Set(uncertain.map((c) => c.name))],
            },
          };
        }
        const dict = rt.dataDictionary.getDictionary(args.table);
        if (dict) {
          for (const col of dict.columns) {
            if (col.status === ("ai-guessed" as ColumnSemanticStatus) && mappingColumns.includes(col.name)) {
              dictionaryFlags.aiGuessedColumns.push(col.name);
            }
          }
        }
      } catch {
        // 字典联动失败不阻断模板（best-effort 提醒）
      }

      // 5. 安全检查（每条生成 SQL 都过与 query_data 同一拦截器）
      for (const s of sqls) {
        const sqlCheck = rt.security.checkSql(s);
        if (sqlCheck.action === "block") {
          return {
            content: [{ type: "text", text: `Security blocked: ${sqlCheck.reason}` }],
            details: { toolName: "run_analysis_template", blocked: true, reason: sqlCheck.reason },
          };
        }
      }

      // 6. 执行（复用 query_data 内核 + 错误恢复；逐条）
      const execOne = async (s: string) =>
        executeWithRecovery(
          async () => await rt.engine!.executeQueryWithLimit(s),
          {},
          { sql: s, tableName: args.table, engine: rt.engine, toolName: "run_analysis_template" },
          onUpdate ? (msg: string) => onUpdate({ content: [{ type: "text", text: msg }], details: { recoveryUpdate: true } }) : undefined
        );
      const toRowObjects = (qr: QueryResult): Array<Record<string, unknown>> => {
        return qr.rows.map((r) => {
          const o: Record<string, unknown> = {};
          qr.columns.forEach((c, i) => { o[c.name] = r[i]; });
          return o;
        });
      };
      const results: QueryResult[] = [];
      for (const s of sqls) {
        const recovery = await execOne(s);
        if (!recovery.result) {
          return recoveryResultToToolResult(recovery, "run_analysis_template");
        }
        results.push(recovery.result);
      }

      // 7. 确定性结果计算（invariant 违规在此抛出 → 结构化错误，不产出叙述）
      const result = results[0];

      try {
        let outcome: { text: string; details: Record<string, unknown> };
        if (kind === "funnel") {
          outcome = funnelOutcome(args.table, funnelParams!, sql, toRowObjects(result)[0] ?? {}, dictionaryFlags);
        } else if (kind === "cohort") {
          outcome = cohortOutcome(args.table, cohortParams!, sql, toRowObjects(result), dictionaryFlags);
        } else {
          const armRows = toRowObjects(result);
          if (armRows.length !== 2) {
            const values = armRows.map((r) => `"${String(r.variant)}"`).join("、");
            return {
              content: [{
                type: "text",
                text: `Error: ${abParams!.variant_column} 必须恰好有 2 个非空取值（当前 ${armRows.length} 个：${values}）。请检查分组列，或先用条件过滤出目标两臂。`,
              }],
              details: {
                toolName: "run_analysis_template",
                error: "invalid_params",
                param: "variant_column",
                variantColumn: abParams!.variant_column,
                message: `恰好 2 个非空取值，实际 ${armRows.length} 个`,
              },
            };
          }
          const segmentResults = abParams!.segment_columns.map((col, i) => ({ column: col, rows: toRowObjects(results[i + 1]) }));
          outcome = abTestOutcome(args.table, abParams!, sql, armRows, segmentResults, dictionaryFlags);
        }
        return {
          content: [{ type: "text", text: outcome.text }],
          details: {
            ...outcome.details,
            totalRowCount: result.totalRowCount,
            executionTimeMs: result.executionTimeMs,
          },
        };
      } catch (err) {
        // sanity 不变量违规（结构上不应发生）——如实返回，绝不产出看似合理的叙述
        return {
          content: [{
            type: "text",
            text: `Error: 模板 sanity 校验失败：${err instanceof Error ? err.message : String(err)}`,
          }],
          details: { toolName: "run_analysis_template", error: "sanity_violation", sql },
        };
      }
    },
  };
}
