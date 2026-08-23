/**
 * S3.2 active-questioning — 主动反问拦截 Hook（v2：基于 user_intent 优先）
 *
 * 触发：pi.on("tool_call") 拦截 query_data
 * （注：Pi Extension API 中使用 "tool_call" 事件，对应 Spec 中概念性的 "beforeToolCall"）
 *
 * 修复要点：
 * - 优先基于 user_intent（用户原始自然语言）判断歧义，而非模型脑补后的 SQL
 * - SQL 层检测保留作为兜底
 * - 一票触发开放式表达（如"分析一下"、"看看数据"）
 * - 未指定目标/指标/维度/时间范围时触发反问
 */

import type {
  ToolCallEvent,
  ToolCallEventResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { DataDictionaryManager } from "./data-dictionary.js";
import type { DuckDBEngine } from "../engine/duckdb.js";

/** 歧义检测结果 */
interface AmbiguityCheck {
  isAmbiguous: boolean;
  reasons: string[];
  suggestedQuestion?: string;
  suggestedOptions?: Array<{
    id: string;
    label: string;
    impliedAssumption: string;
  }>;
}

/** 一票触发的开放式表达（user_intent 匹配） */
const OPEN_ENDED_EXPRESSIONS = [
  /分析一下/, /看一下/, /看看数据/, /整体情况/,
  /有什么发现/, /帮我分析/,
  /analyze/i, /take a look/i, /look at the data/i,
  /overview/i, /summary/i, /tell me about/i,
  /帮?我?看看?这?个?表/, /看看?这些?数据/,
];

/** 模糊关键词列表（user_intent 层检测） */
const AMBIGUOUS_KEYWORDS_INTENT = [
  "活跃", "active", "最近", "recent", "增长", "growth",
  "下降", "decline", "热门", "popular", "趋势", "trend",
  "表现", "performance", "效果", "effectiveness",
  "质量", "quality", "异常", "anomaly",
];

/** 模糊关键词列表（SQL 层兜底检测） */
const AMBIGUOUS_KEYWORDS_SQL = [
  "active", "recent", "growth", "decline",
  "popular", "trend", "performance", "effectiveness",
  "quality", "anomaly",
];

/** 时间相关模糊词（user_intent 层） */
const TIME_AMBIGUOUS_PATTERNS_INTENT = [
  /最近|recently|lately|近期/,
  /去年|last year|今年|this year/,
  /上个月|last month|这个月|this month/,
  /上周|last week|这周|this week/,
];

/**
 * 检测 user_intent 是否明确指定了分析目标、指标、维度或时间范围
 * 返回未指定的维度列表
 */
function detectMissingDimensions(userIntent: string): string[] {
  const missing: string[] = [];
  const lower = userIntent.toLowerCase();

  // 是否指定了分析目标（如"按XX分组"、"统计XX"、"求XX"）
  const hasTarget = /(按|分组|统计|求|计算|对比|比较|top|排名|排序|找出)/i.test(userIntent) ||
    /(count|sum|avg|min|max|group by|order by|where)/i.test(userIntent);
  if (!hasTarget) {
    missing.push("分析目标（如统计、分组、排序）");
  }

  // 是否指定了指标/字段
  const hasMetric = /(数量|个数|平均|最大|最小|总和|占比|比例|行数|总行数|条数|总计|rate|ratio)/i.test(userIntent) ||
    /\b(count|sum|avg|min|max|mean|total|rows?|records?)\b/i.test(userIntent);
  if (!hasMetric) {
    missing.push("指标/字段（如数量、平均值、最大值）");
  }

  // 是否指定了维度
  const hasDimension = /(按|分组|维度|维度)/i.test(userIntent) ||
    /\b(group by|by)\b/i.test(userIntent);
  if (!hasDimension) {
    missing.push("分析维度（如按类别分组）");
  }

  // 是否指定了时间范围（仅当意图涉及时间相关概念时检查）
  const hasTimeMention = /(最近|近期|时间|日期|月份|年份|week|month|year|daily|weekly|monthly)/i.test(userIntent);
  const hasTimeRange = /(\d{4}|\d{1,2}月|\d{1,2}日|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|202[0-9]|20[0-9]{2})/i.test(userIntent);
  if (hasTimeMention && !hasTimeRange) {
    missing.push("时间范围（如最近7天、2024年）");
  }

  return missing;
}

/**
 * 检测歧义
 *
 * 优先级：
 * 1. user_intent 一票触发（开放式表达）
 * 2. user_intent 维度缺失检测
 * 3. user_intent 模糊关键词
 * 4. SQL 层兜底检测
 */
export function detectAmbiguity(
  userIntent: string,
  sql: string,
): AmbiguityCheck {
  const reasons: string[] = [];
  const lowerIntent = userIntent.toLowerCase();
  const lowerSql = sql.toLowerCase();

  // ========== Level 1: 一票触发开放式表达 ==========
  for (const pattern of OPEN_ENDED_EXPRESSIONS) {
    if (pattern.test(userIntent)) {
      reasons.push(`开放式表达"${userIntent}" — 缺少明确的分析目标、指标或维度`);
      // 一票触发，直接返回
      return buildAmbiguityResult(reasons, "open_ended");
    }
  }

  // ========== Level 2: 用户意图维度缺失 ==========
  const missingDimensions = detectMissingDimensions(userIntent);
  if (missingDimensions.length >= 3) {
    reasons.push(`用户意图缺少明确的方向：${missingDimensions.join("、")}`);
    return buildAmbiguityResult(reasons, "missing_dimensions");
  } else if (missingDimensions.length === 2) {
    reasons.push(`用户意图可能不够明确，缺少：${missingDimensions.join("、")}`);
  }

  // ========== Level 3: user_intent 模糊关键词 ==========
  for (const keyword of AMBIGUOUS_KEYWORDS_INTENT) {
    if (lowerIntent.includes(keyword)) {
      reasons.push(`模糊关键词"${keyword}" — 缺少明确定义（来自用户原始问题）`);
    }
  }

  // 时间范围不明（基于意图）
  const hasTimeCondition = /where.*(date|time|timestamp|created|updated)/i.test(sql);
  const hasTimeKeyword = TIME_AMBIGUOUS_PATTERNS_INTENT.some((p) => p.test(userIntent));
  if (hasTimeKeyword && !hasTimeCondition) {
    reasons.push("时间范围不明确 — 请指定具体时间段（来自用户原始问题）");
  }

  // ========== Level 4: SQL 层兜底检测 ==========
  for (const keyword of AMBIGUOUS_KEYWORDS_SQL) {
    if (lowerSql.includes(keyword) && !lowerIntent.includes(keyword)) {
      // SQL 中有但意图中未提及的模糊词（模型自行脑补）
      reasons.push(`SQL 中使用了未在用户意图中明确的模糊词"${keyword}"`);
    }
  }

  // 聚合无分组（COUNT(*) 做总行数统计是合理的，排除）
  const hasAggregate = /\b(sum|avg|min|max)\s*\(/i.test(sql);
  const hasGroupBy = /\bgroup\s+by\b/i.test(sql);
  if (hasAggregate && !hasGroupBy && !/\bwhere\b/i.test(sql)) {
    reasons.push("聚合查询缺少分组条件 — 请确认统计维度");
  }

  // SELECT * 无 LIMIT
  if (/select\s+\*/i.test(sql) && !/\blimit\b/i.test(sql)) {
    reasons.push("SELECT * 无 LIMIT — 可能返回大量数据");
  }

  // 歧义判断：有 2+ 个理由才触发（Level 1/2 已一票触发，这里主要处理 Level 3/4 组合）
  const isAmbiguous = reasons.length >= 2;

  if (!isAmbiguous) {
    return { isAmbiguous: false, reasons: [] };
  }

  return buildAmbiguityResult(reasons, "combined");
}

/**
 * 构建歧义结果
 */
function buildAmbiguityResult(
  reasons: string[],
  triggerType: "open_ended" | "missing_dimensions" | "combined"
): AmbiguityCheck {
  let suggestedQuestion: string;
  let suggestedOptions: Array<{ id: string; label: string; impliedAssumption: string }>;

  if (triggerType === "open_ended" || triggerType === "missing_dimensions") {
    suggestedQuestion = "您的分析请求较为开放，请选择您希望的分析方向：";
    suggestedOptions = [
      {
        id: "overview",
        label: "整体概览",
        impliedAssumption: "用户希望了解数据的基本概况，包括行数、字段、缺失值、基础分布",
      },
      {
        id: "group_comparison",
        label: "分组对比",
        impliedAssumption: "用户希望按主要类别字段进行分组统计，对比不同类别的差异",
      },
      {
        id: "anomaly_check",
        label: "异常检查",
        impliedAssumption: "用户希望发现数据中的异常，包括极值、缺失值、重复记录和异常波动",
      },
    ];
  } else {
    suggestedQuestion = "查询存在歧义，请确认以下问题：";
    suggestedOptions = [
      {
        id: "proceed_anyway",
        label: "继续执行（我理解风险）",
        impliedAssumption: "用户接受当前查询的歧义性，自行承担解释风险",
      },
      {
        id: "clarify_first",
        label: "先澄清口径",
        impliedAssumption: "用户需要更明确的查询定义，Agent 应调用 ask_clarification",
      },
    ];
  }

  return {
    isAmbiguous: true,
    reasons,
    suggestedQuestion,
    suggestedOptions,
  };
}

/**
 * 创建 tool_call 事件处理器
 *
 * 用法：pi.on("tool_call", createActiveQuestioningHandler(...))
 */
export function createActiveQuestioningHandler(params: {
  dictionaryManager: DataDictionaryManager;
  getEngine?: () => DuckDBEngine | null;
}) {
  return async (
    event: ToolCallEvent,
    ctx: ExtensionContext
  ): Promise<ToolCallEventResult | undefined> => {
    // 只拦截 query_data
    if (event.toolName !== "query_data") {
      return undefined;
    }

    const input = event.input as {
      sql?: string;
      user_intent?: string;
      table_name?: string;
    };
    const sql = input.sql ?? "";
    const userIntent = input.user_intent ?? "";

    // 0. 检查 user_intent 是否存在（query_data 自身也会检查，这里作为 hook 也做兜底）
    if (!userIntent || userIntent.trim().length === 0) {
      return {
        block: true,
        reason: "Missing user_intent: query_data requires the user's original natural language question. Please pass user_intent.",
      };
    }

    // 1. 检查数据字典（如果指定了表名）
    //    不再硬 block，改为自动尝试生成
    if (input.table_name) {
      const hasDict = params.dictionaryManager.hasDictionary(input.table_name);
      if (!hasDict) {
        // 尝试自动生成 ai-guessed 字典
        const engine = params.getEngine?.();
        if (engine) {
          try {
            await params.dictionaryManager.ensureDictionary(input.table_name, engine);
            // 生成成功，允许继续（query_data 内部会附加口径提示）
          } catch (dictErr) {
            return {
              block: true,
              reason: `Failed to auto-generate dictionary for "${input.table_name}". Please run describe_data first.`,
            };
          }
        }
        // 无 engine 可用：不阻塞，依赖 query_data 内部提示
      }
    }

    // 2. 歧义检测（基于 user_intent 优先）
    const ambiguity = detectAmbiguity(userIntent, sql);
    if (ambiguity.isAmbiguous) {
      return {
        block: true,
        reason: `Ambiguity detected: ${ambiguity.reasons.join("; ")}. Please clarify before executing.`,
      };
    }

    // 放行
    return undefined;
  };
}
