/**
 * v0.13 TPL — PM 分析模板：确定性 SQL 生成与结果计算（funnel / cohort / ab_test）
 *
 * 统计红线（v0.13 spec 三红线之一）：所有数值（人数、转化率、留存率）由本模块的
 * 确定性代码计算，LLM 只解释、不产生数值。模板 SQL 只读 SELECT，执行前仍过
 * security.checkSql 与 query_data 同一执行内核。
 *
 * 语义（固定，随 method_notes 输出）：
 * - funnel（状态漏斗）：第 k 步 = 满足前 k 步条件合取的 distinct user_key——用户级
 *   条件叠加（每个条件在该用户至少一行上成立），不含步序时间约束（事件序列漏斗
 *   不在 v1 范围，spec §4.2 Deferred）；状态互斥型数据不适用（method_notes 说明）。
 * - cohort：按 activity_time 的自然周/月分群，第 N 期留存 = 该群在首期+N 期仍有
 *   活动记录的 distinct user_key 占比；长期格式输出（cohort × offset）。
 */

import { quoteSqlIdentifier } from "../utils/sql.js";

// ============================================================================
// 参数模型与校验
// ============================================================================

export type TemplateKind = "funnel" | "cohort" | "ab_test";

export interface FunnelStep {
  /** 步骤名（如「访问」「加购」），仅用于展示 */
  label: string;
  /** WHERE 布尔条件（该表列上的 SQL 表达式，原样嵌入并整体过安全校验） */
  condition: string;
}

export interface FunnelParams {
  steps: FunnelStep[];
  user_key: string;
  /** 与 window_days 成对出现：数据最新时间往前 N 天 */
  time_column?: string;
  window_days?: number;
}

export interface CohortParams {
  user_key: string;
  activity_time: string;
  period: "week" | "month";
  /** 可选活动条件（如 "kind = 'purchase'"），用于排除噪声行为 */
  activity_condition?: string;
  /** 期数偏移上限，默认 12，最大 24 */
  lookback: number;
}

/** 参数错误（结构化返回给模型，含修正指引） */
export class TemplateParamError extends Error {
  readonly param: string;
  constructor(param: string, message: string) {
    super(message);
    this.param = param;
  }
}

const FUNNEL_MIN_STEPS = 2;
const FUNNEL_MAX_STEPS = 8;
const COHORT_MAX_LOOKBACK = 24;
const COHORT_DEFAULT_LOOKBACK = 12;
const MAX_WINDOW_DAYS = 3650;

/** 条件片段基本卫生：非空、无分号结尾注入面、长度受限（整体安全性仍由 checkSql 把关） */
function validateCondition(condition: unknown, where: string): string {
  if (typeof condition !== "string" || condition.trim().length === 0) {
    throw new TemplateParamError(where, `${where} 条件不能为空，应为该表列上的 WHERE 布尔表达式（如 "amount >= 50"）`);
  }
  if (condition.length > 500) {
    throw new TemplateParamError(where, `${where} 条件过长（>500 字符），请先在 SQL 层建视图或用 transform_data 物化中间表`);
  }
  return condition.trim();
}

/** 校验并规范化 funnel 参数（非法即抛 TemplateParamError） */
export function validateFunnelParams(raw: Record<string, unknown>): FunnelParams {
  const stepsRaw = raw.steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length < FUNNEL_MIN_STEPS || stepsRaw.length > FUNNEL_MAX_STEPS) {
    throw new TemplateParamError(
      "steps",
      `funnel 需要至少 ${FUNNEL_MIN_STEPS} 步、最多 ${FUNNEL_MAX_STEPS} 步（当前 ${Array.isArray(stepsRaw) ? stepsRaw.length : "非数组"}）；每步形如 { label, condition }`
    );
  }
  const steps: FunnelStep[] = stepsRaw.map((s, i) => {
    const obj = (s ?? {}) as Record<string, unknown>;
    const label = typeof obj.label === "string" && obj.label.trim() ? obj.label.trim() : `step_${i + 1}`;
    return { label, condition: validateCondition(obj.condition, `steps[${i}].condition`) };
  });

  const userKey = raw.user_key;
  if (typeof userKey !== "string" || !userKey.trim()) {
    throw new TemplateParamError("user_key", "user_key 必填：去重键列名（如 user_id / order_id），漏斗按它 distinct 计数");
  }

  const timeColumn = typeof raw.time_column === "string" && raw.time_column.trim() ? raw.time_column.trim() : undefined;
  const windowDays = raw.window_days;
  let window: number | undefined;
  if (timeColumn !== undefined || windowDays !== undefined) {
    // 成对出现（spec §4.2）
    if (timeColumn === undefined || typeof windowDays !== "number" || !Number.isInteger(windowDays) || windowDays < 1 || windowDays > MAX_WINDOW_DAYS) {
      throw new TemplateParamError("window_days", "time_column 与 window_days 必须成对提供，window_days 为 1~3650 的整数（分析窗口 = 数据最新时间往前 N 天）");
    }
    window = windowDays;
  }

  return { steps, user_key: userKey.trim(), time_column: timeColumn, window_days: window };
}

/** 校验并规范化 cohort 参数 */
export function validateCohortParams(raw: Record<string, unknown>): CohortParams {
  const userKey = raw.user_key;
  if (typeof userKey !== "string" || !userKey.trim()) {
    throw new TemplateParamError("user_key", "user_key 必填：用户/实体去重键列名");
  }
  const activityTime = raw.activity_time;
  if (typeof activityTime !== "string" || !activityTime.trim()) {
    throw new TemplateParamError("activity_time", "activity_time 必填：活动时间列（DATE/TIMESTAMP）");
  }
  const period = raw.period;
  if (period !== "week" && period !== "month") {
    throw new TemplateParamError("period", `period 必须为 "week" 或 "month"（当前 ${JSON.stringify(period ?? null)}）`);
  }
  const rawLookback = raw.lookback;
  let lookback = COHORT_DEFAULT_LOOKBACK;
  if (rawLookback !== undefined) {
    if (typeof rawLookback !== "number" || !Number.isInteger(rawLookback) || rawLookback < 1 || rawLookback > COHORT_MAX_LOOKBACK) {
      throw new TemplateParamError("lookback", `lookback 为 1~${COHORT_MAX_LOOKBACK} 的整数（默认 ${COHORT_DEFAULT_LOOKBACK}）`);
    }
    lookback = rawLookback;
  }
  const activityCondition =
    raw.activity_condition === undefined || raw.activity_condition === null
      ? undefined
      : validateCondition(raw.activity_condition, "activity_condition");

  return { user_key: userKey.trim(), activity_time: activityTime.trim(), period, activity_condition: activityCondition, lookback };
}

// ============================================================================
// SQL 生成（确定性）
// ============================================================================

/** funnel SQL：用户级条件叠加 → 累计合取计数，单条 SELECT 完成 */
export function buildFunnelSql(table: string, params: FunnelParams): string {
  const tbl = quoteSqlIdentifier(table);
  const uk = quoteSqlIdentifier(params.user_key);
  const timeCol = params.time_column ? quoteSqlIdentifier(params.time_column) : null;

  const whereClause =
    timeCol && params.window_days !== undefined
      ? `WHERE ${timeCol} >= (SELECT max(${timeCol}) - INTERVAL (${params.window_days}) DAY FROM ${tbl})`
      : "";

  const boolOrs = params.steps
    .map((s, i) => `bool_or((${s.condition})) AS s${i + 1}`)
    .join(",\n       ");
  const cumFilters = params.steps
    .map((_, i) => params.steps.slice(0, i + 1).map((_, j) => `s${j + 1}`).join(" AND "))
    .map((cond, i) => `COUNT(*) FILTER (WHERE ${cond}) AS step_${i + 1}`)
    .join(",\n       ");

  return [
    `WITH per_user AS (`,
    `  SELECT ${uk} AS uk,`,
    `       ${boolOrs}`,
    `  FROM ${tbl}`,
    whereClause ? `  ${whereClause}` : `  WHERE 1=1`,
    `  GROUP BY ${uk}`,
    `)`,
    `SELECT ${cumFilters}`,
    `FROM per_user`,
  ].join("\n");
}

/** cohort SQL：长期格式（cohort × offset），留存计算在 TS 侧完成 */
export function buildCohortSql(table: string, params: CohortParams): string {
  const tbl = quoteSqlIdentifier(table);
  const uk = quoteSqlIdentifier(params.user_key);
  const ts = quoteSqlIdentifier(params.activity_time);
  const truncPart = params.period;
  const diffPart = params.period;
  const whereClause = params.activity_condition
    ? `WHERE (${params.activity_condition}) AND ${ts} IS NOT NULL AND ${uk} IS NOT NULL`
    : `WHERE ${ts} IS NOT NULL AND ${uk} IS NOT NULL`;

  return [
    `WITH activity AS (`,
    `  SELECT ${uk} AS uk, date_trunc('${truncPart}', CAST(${ts} AS TIMESTAMP)) AS p`,
    `  FROM ${tbl}`,
    `  ${whereClause}`,
    `), first_p AS (`,
    `  SELECT uk, min(p) AS fp FROM activity GROUP BY uk`,
    `), pairs AS (`,
    `  SELECT f.fp AS cohort_start, date_diff('${diffPart}', f.fp, a.p) AS offset_n, a.uk`,
    `  FROM first_p f JOIN activity a ON a.uk = f.uk`,
    `  WHERE date_diff('${diffPart}', f.fp, a.p) BETWEEN 0 AND ${params.lookback}`,
    `), sizes AS (`,
    `  SELECT fp AS cohort_start, COUNT(DISTINCT uk) AS size FROM first_p GROUP BY fp`,
    `)`,
    `SELECT s.size, p.cohort_start, p.offset_n, COUNT(DISTINCT p.uk) AS retained`,
    `FROM pairs p JOIN sizes s ON s.cohort_start = p.cohort_start`,
    `GROUP BY s.size, p.cohort_start, p.offset_n`,
    `ORDER BY p.cohort_start, p.offset_n`,
  ].join("\n");
}

// ============================================================================
// 结果计算（确定性）与 sanity 分诊（AB-2 共用组件的 funnel/cohort 规则）
// ============================================================================

export interface FunnelStepResult {
  step: number;
  label: string;
  users: number;
  /** 相对上一步的转化率（%），step 1 为 100 */
  stepConversionPct: number | null;
  /** 相对第 1 步的累计转化率（%） */
  totalConversionPct: number | null;
}

export interface FunnelResult {
  steps: FunnelStepResult[];
  warnings: string[];
}

const toNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 行值 → 展示字符串（TIMESTAMP/DATE 统一 ISO 前 10 位） */
export function normalizeDateValue(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v ?? "");
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/**
 * funnel 行（单行多列 step_1..step_n）→ 步骤结果。
 * 累计合取语义下人数单调不增是结构保证；若被违反说明 SQL/计算有 bug，升级为错误。
 */
export function computeFunnelResult(params: FunnelParams, row: Record<string, unknown>): FunnelResult {
  const warnings: string[] = [];
  const steps: FunnelStepResult[] = [];
  let prev: number | null = null;

  params.steps.forEach((s, i) => {
    const users = toNum(row[`step_${i + 1}`]);
    if (prev !== null && users > prev) {
      // 结构上不可能；触发即视为模板 bug，按硬错误分诊（AB-2 hard check 语义）
      throw new Error(`funnel sanity 违规：第 ${i + 1} 步人数 ${users} 大于第 ${i} 步 ${prev}——累计合取语义下不应发生，请携带 sql 字段报告此问题`);
    }
    // 累计转化率基准 = 第 1 步人数（处理 step 1 时 steps 数组尚为空，直接用当前值）
    const base = i === 0 ? users : steps[0].users;
    steps.push({
      step: i + 1,
      label: s.label,
      users,
      stepConversionPct: prev === null || prev === 0 ? null : Math.round((users / prev) * 1000) / 10,
      totalConversionPct: base > 0 ? Math.round((users / base) * 1000) / 10 : null,
    });
    if (users === 0 && prev !== null && prev > 0 && i === params.steps.length - 1) {
      warnings.push(`最后一步人数为 0：请检查各步条件是否为递进关系（后一步条件应包含前一步的人群特征），或窗口过窄。`);
    }
    prev = users;
  });

  if (steps[0].users === 0) {
    warnings.push("第 1 步人数为 0：窗口内无满足第一步条件的用户，结果无意义。");
  }

  return { steps, warnings };
}

export interface CohortOffset {
  offset: number;
  retained: number;
  retentionPct: number;
}

export interface CohortGroup {
  /** 群起始期（ISO 日期，date_trunc 归一化） */
  cohort: string;
  size: number;
  offsets: CohortOffset[];
}

export interface CohortResult {
  cohorts: CohortGroup[];
  /** 各 offset 的平均留存率（各群简单平均，未按群规模加权） */
  averageRetentionPct: Array<{ offset: number; avgPct: number }>;
  warnings: string[];
}

/** cohort 长格式行 → 分群结果 + 均值。留存率越界为不变量违规（硬错误）。 */
export function computeCohortResult(rows: Array<Record<string, unknown>>): CohortResult {
  const warnings: string[] = [];
  const byCohort = new Map<string, { size: number; offsets: Map<number, number> }>();

  for (const r of rows) {
    const cohort = normalizeDateValue(r.cohort_start);
    const size = toNum(r.size);
    const offset = toNum(r.offset_n);
    const retained = toNum(r.retained);
    let g = byCohort.get(cohort);
    if (!g) {
      g = { size, offsets: new Map() };
      byCohort.set(cohort, g);
    }
    if (retained > g.size) {
      throw new Error(`cohort sanity 违规：${cohort} 第 ${offset} 期留存人数 ${retained} 大于群规模 ${g.size}——不应发生，请携带 sql 字段报告此问题`);
    }
    g.offsets.set(offset, retained);
  }

  const cohorts: CohortGroup[] = [...byCohort.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohort, g]) => ({
      cohort,
      size: g.size,
      offsets: [...g.offsets.entries()]
        .sort(([a], [b]) => a - b)
        .map(([offset, retained]) => ({
          offset,
          retained,
          retentionPct: g.size > 0 ? Math.round((retained / g.size) * 1000) / 10 : 0,
        })),
    }));

  if (cohorts.length === 0) {
    warnings.push("无分群结果：窗口内没有满足条件的活动记录，请检查条件与时间列。");
  }

  // 各 offset 平均（仅统计有该期数据的群）
  const maxOffset = Math.max(0, ...cohorts.flatMap((c) => c.offsets.map((o) => o.offset)));
  const averageRetentionPct: Array<{ offset: number; avgPct: number }> = [];
  for (let off = 0; off <= maxOffset; off++) {
    const rates = cohorts
      .map((c) => c.offsets.find((o) => o.offset === off))
      .filter((o): o is CohortOffset => !!o)
      .map((o) => o.retentionPct);
    if (rates.length === 0) continue;
    averageRetentionPct.push({
      offset: off,
      avgPct: Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10) / 10,
    });
  }

  return { cohorts, averageRetentionPct, warnings };
}

// ============================================================================
// 固定"方法与局限"小节（统计红线：随结果输出，不可省略）
// ============================================================================

export function funnelMethodNotes(params: FunnelParams): string {
  const windowText = params.time_column ? `分析窗口 = 数据最新时间往前 ${params.window_days} 天` : "未设时间窗口（全表）";
  return (
    `方法与局限：状态漏斗——第 k 步 = 满足前 k 步条件合取的 distinct ${params.user_key}` +
    `（每个条件在该用户至少一行上成立；不含步序时间约束，事件序列漏斗不在本模板范围）。` +
    `${windowText}。转化率基于去重后的用户数；样本量小（<100）时波动大，谨慎外推。` +
    `状态互斥型数据（每行一个 status，如订单状态列）不适用本模板——请改用分组对比或 cohort 模板。`
  );
}

export function cohortMethodNotes(params: CohortParams): string {
  return (
    `方法与局限：${params.period === "month" ? "月度" : "周度"} cohort——按 ${params.activity_time} 的自然${params.period === "month" ? "月" : "周"}分群，` +
    `第 N 期留存 = 该群在首次活跃期+N 期仍有活动记录的 distinct ${params.user_key} 占比（未出现即未留存，不做插值）。` +
    `offset 0 = 首期本身（100%）。均值 = 各群留存率的简单平均（未按群规模加权），早期小群可能扭曲均值。` +
    `lookback = ${params.lookback} 期，超出数据范围期数自然为空。` +
    (params.activity_condition ? `活动条件：${params.activity_condition}。` : "未设活动条件（全部行为计入）。")
  );
}

export const FUNNEL_CHART_SUGGESTION =
  "bar 图（x=步骤 label，y=users）展示漏斗；或折线展示 stepConversionPct。建议配合 visualize 工具使用。";
export const COHORT_CHART_SUGGESTION =
  "line 图（x=offset，y=retentionPct，每个 cohort 一条线）展示留存曲线；数据适合热力图（cohort × offset）。建议配合 visualize 工具使用。";

// ============================================================================
// AB-1：A/B 双比例 z 检验（阶段三）
// ============================================================================

/** 标准正态分布 CDF——Zelen & Severo 近似（Abramowitz-Stegun 26.2.17），|ε| < 7.5e-8 */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  if (!Number.isFinite(ax)) return sign > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * ax);
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upper = 1 - (Math.exp(-ax * ax / 2) / Math.sqrt(2 * Math.PI)) * poly;
  return sign > 0 ? upper : 1 - upper;
}

export interface AbTestParams {
  /** 分组列：必须恰好 2 个非空取值 */
  variant_column: string;
  /** 转化布尔条件（该表列上的 SQL 表达式） */
  success_condition: string;
  /** 去重粒度列（unit 级计数，同一 unit 多行只算一次） */
  unit: string;
  /** Simpson 悖论扫描的维度列（≤3） */
  segment_columns: string[];
  /** 显著性水平，默认 0.05 */
  alpha: number;
}

/** 校验并规范化 ab_test 参数 */
export function validateAbTestParams(raw: Record<string, unknown>): AbTestParams {
  const variantColumn = raw.variant_column;
  if (typeof variantColumn !== "string" || !variantColumn.trim()) {
    throw new TemplateParamError("variant_column", "variant_column 必填：分组列名（该列必须恰好有 2 个非空取值）");
  }
  const unit = raw.unit;
  if (typeof unit !== "string" || !unit.trim()) {
    throw new TemplateParamError("unit", "unit 必填：去重粒度列（如 user_id；同一 unit 多行只计一次）");
  }
  const success = validateCondition(raw.success_condition, "success_condition");

  const rawSegments = raw.segment_columns;
  let segmentColumns: string[] = [];
  if (rawSegments !== undefined && rawSegments !== null) {
    if (!Array.isArray(rawSegments) || rawSegments.some((s) => typeof s !== "string" || !s.trim())) {
      throw new TemplateParamError("segment_columns", "segment_columns 应为非空列名数组（0~3 个）");
    }
    segmentColumns = [...new Set((rawSegments as string[]).map((s) => s.trim()))];
    if (segmentColumns.length > 3) {
      throw new TemplateParamError("segment_columns", "segment_columns 最多 3 列（辛普森扫描维度过多会稀释结论）");
    }
  }

  let alpha = 0.05;
  if (raw.alpha !== undefined) {
    if (typeof raw.alpha !== "number" || !(raw.alpha > 0 && raw.alpha < 1)) {
      throw new TemplateParamError("alpha", "alpha 必须为 0~1 之间的数（默认 0.05）");
    }
    alpha = raw.alpha;
  }

  return {
    variant_column: variantColumn.trim(),
    success_condition: success,
    unit: unit.trim(),
    segment_columns: segmentColumns,
    alpha,
  };
}

/** 总体双臂聚合 SQL（unit 级去重：同一 unit 多行只算一次） */
export function buildAbTestOverallSql(table: string, params: AbTestParams): string {
  const tbl = quoteSqlIdentifier(table);
  const v = quoteSqlIdentifier(params.variant_column);
  const u = quoteSqlIdentifier(params.unit);
  return [
    `SELECT ${v} AS variant,`,
    `       COUNT(DISTINCT ${u}) AS n,`,
    `       COUNT(DISTINCT CASE WHEN (${params.success_condition}) THEN ${u} END) AS conv`,
    `FROM ${tbl}`,
    `WHERE ${v} IS NOT NULL AND ${u} IS NOT NULL`,
    `GROUP BY ${v}`,
    `ORDER BY ${v}`,
  ].join("\n");
}

/** 分段聚合 SQL（Simpson 扫描；每段内重复同一 unit 去重语义） */
export function buildAbTestSegmentSql(table: string, params: AbTestParams, segmentColumn: string): string {
  const tbl = quoteSqlIdentifier(table);
  const v = quoteSqlIdentifier(params.variant_column);
  const u = quoteSqlIdentifier(params.unit);
  const seg = quoteSqlIdentifier(segmentColumn);
  return [
    `SELECT ${seg} AS seg, ${v} AS variant,`,
    `       COUNT(DISTINCT ${u}) AS n,`,
    `       COUNT(DISTINCT CASE WHEN (${params.success_condition}) THEN ${u} END) AS conv`,
    `FROM ${tbl}`,
    `WHERE ${v} IS NOT NULL AND ${u} IS NOT NULL`,
    `GROUP BY ${seg}, ${v}`,
    `ORDER BY ${seg}, ${v}`,
  ].join("\n");
}

export interface AbArm {
  variant: string;
  n: number;
  conv: number;
  rate: number;
}

export interface AbTestResult {
  /** 按 variant 字典序（arm1 = 字典序较小值，z 以 arm2 − arm1 为符号） */
  arms: AbArm[];
  /** 检验统计量；p̂ 退化（0/1）时为 null */
  z: number | null;
  p: number | null;
  pooled: number;
  significant: boolean;
  alpha: number;
  /** 绝对差（百分点，arm2 − arm1） */
  absDiffPct: number | null;
  /** 相对 lift（(arm2 − arm1) / arm1） */
  liftPct: number | null;
  /** 总体方向上更优的臂（rate 较高者；持平为 null） */
  betterArm: string | null;
  warnings: string[];
  /** 辛普森悖论扫描发现（方向相反的段） */
  simpsonFindings: string[];
}

/**
 * A/B 结果计算与四项护栏（全部确定性输出）：
 * ① 样本量（任一臂 n<100 或期望计数 min(n·p̂, n·(1−p̂))<5）；
 * ② 辛普森扫描（段内方向 vs 总体方向相反）；
 * ③ 边缘显著（p ∈ (0.01, 0.2)）；
 * ④ 效应量（绝对差 + 相对 lift）。
 * 退化情形（任一臂转化 0/全转化、p̂ 为 0/1）→ 无法检验，z/p 为 null。
 */
export function computeAbTestResult(
  params: AbTestParams,
  armRows: Array<Record<string, unknown>>,
  segmentResults: Array<{ column: string; rows: Array<Record<string, unknown>> }>,
): AbTestResult {
  const warnings: string[] = [];
  const simpsonFindings: string[] = [];

  const arms: AbArm[] = armRows
    .map((r) => {
      const n = toNum(r.n);
      const conv = toNum(r.conv);
      return { variant: String(r.variant), n, conv, rate: n > 0 ? conv / n : 0 };
    })
    .sort((a, b) => a.variant.localeCompare(b.variant));

  if (arms.length !== 2) {
    throw new Error(`ab_test sanity 违规：臂数量为 ${arms.length}（应为 2）——不应到达此处，请携带 sql 字段报告此问题`);
  }
  const [a1, a2] = arms;
  if (a1.n <= 0 || a2.n <= 0) {
    throw new Error(`ab_test sanity 违规：存在样本量为 0 的臂（${a1.n} / ${a2.n}）`);
  }

  if (a1.conv === 0 || a1.conv === a1.n || a2.conv === 0 || a2.conv === a2.n) {
    warnings.push("存在转化率 0% 或 100% 的臂，无法进行有意义的比例检验。");
  }

  const pooled = (a1.conv + a2.conv) / (a1.n + a2.n);
  let z: number | null = null;
  let p: number | null = null;
  let significant = false;

  if (pooled <= 0 || pooled >= 1) {
    warnings.push("合并转化率为 0% 或 100%，标准误退化为 0，无法计算 z 与 p 值。");
  } else {
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / a1.n + 1 / a2.n));
    z = (a2.rate - a1.rate) / se;
    p = 2 * (1 - normalCdf(Math.abs(z)));
    significant = p < params.alpha;

    // 护栏 ③：边缘显著提示
    if (p > 0.01 && p < 0.2) {
      warnings.push(`p = ${p.toFixed(4)} 处于边缘区间 (0.01, 0.2)：证据强度有限，谨慎下结论，建议更多样本。`);
    }
    // 护栏 ①：样本量
    for (const arm of arms) {
      if (arm.n < 100) {
        warnings.push(`臂 "${arm.variant}" 样本量 ${arm.n} < 100：正态近似不可靠，标记样本不足。`);
      }
      const expectedMin = Math.min(arm.n * pooled, arm.n * (1 - pooled));
      if (expectedMin < 5) {
        warnings.push(`臂 "${arm.variant}" 期望转化/未转化计数 ${expectedMin.toFixed(1)} < 5：卡方/正态近似条件不满足，标记样本不足。`);
      }
    }
  }

  const absDiffPct = Math.round((a2.rate - a1.rate) * 100000) / 1000;
  const liftPct = a1.rate > 0 ? Math.round(((a2.rate - a1.rate) / a1.rate) * 100000) / 1000 : null;
  const betterArm = a1.rate === a2.rate ? null : a1.rate > a2.rate ? a1.variant : a2.variant;

  // 护栏 ②：辛普森扫描
  for (const { column, rows } of segmentResults) {
    const bySeg = new Map<string, Map<string, { n: number; conv: number }>>();
    for (const r of rows) {
      const seg = String(r.seg);
      const variant = String(r.variant);
      let m = bySeg.get(seg);
      if (!m) { m = new Map(); bySeg.set(seg, m); }
      m.set(variant, { n: toNum(r.n), conv: toNum(r.conv) });
    }
    for (const [seg, m] of bySeg) {
      const s1 = m.get(a1.variant);
      const s2 = m.get(a2.variant);
      if (!s1 || !s2 || s1.n <= 0 || s2.n <= 0) continue;
      const segBetter = s1.conv / s1.n === s2.conv / s2.n ? null : s1.conv / s1.n > s2.conv / s2.n ? a1.variant : a2.variant;
      if (betterArm && segBetter && segBetter !== betterArm) {
        simpsonFindings.push(
          `${column} = "${seg}"：${a1.variant} ${((s1.conv / s1.n) * 100).toFixed(2)}% vs ${a2.variant} ${((s2.conv / s2.n) * 100).toFixed(2)}%` +
            `（段内 ${segBetter} 优），与总体方向（${betterArm} 优）相反——辛普森悖论风险，分组结论可能与总体相反。`
        );
      }
    }
  }
  if (simpsonFindings.length > 0) {
    warnings.push(`辛普森悖论风险：${simpsonFindings.length} 个分段方向与总体相反，详见 simpsonFindings。`);
  }

  return { arms, z, p, pooled, significant, alpha: params.alpha, absDiffPct, liftPct, betterArm, warnings, simpsonFindings };
}

export function abTestMethodNotes(params: AbTestParams): string {
  return (
    `方法与局限：双侧两比例 z 检验（合并比例估计方差），z = (p₂−p₁)/SE，p = 2·(1−Φ(|z|))；` +
    `正态 CDF 为 TypeScript 确定性实现（Zelen–Severo 近似，误差 < 1e-7）。臂顺序按 ${params.variant_column} 值字典序（arm1 = 字典序较小值，z 以 arm2−arm1 为符号）。` +
    `计数为 ${params.unit} 级去重（同一 unit 多行只计一次）。` +
    `适用条件：两臂独立、unit 互斥、大样本正态近似（护栏会标记 n<100 或期望计数 <5 的情形，不满足时结论不可靠）。` +
    `分段对比仅用于辛普森悖论风险扫描，不构成因果结论；segment 为行级取值，同一 unit 跨段时在各段分别计数。` +
    `本检验不证明因果——显著性受样本量、运行时长与事件触发顺序影响。`
  );
}

export const AB_TEST_CHART_SUGGESTION =
  "bar 图（x=variant，y=转化率）对比两臂；带 segment_columns 时用分组柱状图（x=segment，两臂并列）。建议配合 visualize 工具使用。";
