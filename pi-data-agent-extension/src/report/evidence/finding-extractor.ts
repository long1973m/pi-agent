/**
 * 从 Session transcript 提取 Agent 的分析结论
 *
 * 简化版提取器：扫描 assistant 消息中包含数字和数据的文本，
 * 提取含百分比、趋势描述、对比的关键语句。
 *
 * 注意：真正的 Finding 提炼由模型在 Task 3 完成。
 * 此模块提供基于规则的初步提取，作为 FindingEvidence 的候选。
 */

import type { FindingEvidence, QueryEvidence, ChartEvidence } from "./types.js";
import type { SessionEntry } from "../session-transcript.js";
import { getSessionTranscript, mergeToolResults } from "../session-transcript.js";

// ============================================================================
// 参数类型
// ============================================================================

export interface ExtractFindingsParams {
  sessionEntries: SessionEntry[];
  queries: QueryEvidence[];
  charts: ChartEvidence[];
}

// ============================================================================
// 匹配模式
// ============================================================================

/**
 * 量化语句匹配模式
 *
 * 匹配含以下元素的句子：
 * 1. 数字 + 单位（万、%、元、个、件、条）
 * 2. 趋势词（增长、下降、上升、下滑、增加、减少）+ 数字
 * 3. 排名/比较词（第一、最高、最低、最大、最小、超过、不足）
 * 4. 百分比数字（XX% 或 XX.X%）
 * 5. 倍数表达（X倍、增长了X倍）
 */
const QUANTITATIVE_PATTERNS: RegExp[] = [
  // 百分比
  /\d+\.?\d*%/,
  // 数字 + 中文单位
  /\d[\d,.]*\s*(万|元|个|件|条|人|次|天|月|年|小时|分钟|秒|KB|MB|GB|TB)/,
  // 趋势词 + 数字
  /(?:增长|下降|上升|下滑|增加|减少|提升|降低|回落|反弹|攀升|暴跌|暴涨|缩水|翻倍|减半|持平)\s*[\d,.]*/,
  // 数字 + 趋势词
  /[\d,.]+\s*(?:%|倍|个百分点)/,
  // 排名/比较
  /(?:第一|第二|第三|最高|最低|最大|最小|超过|不足|高于|低于|多于|少于|领先|落后|突破|达到|仅为)/,
  // 倍数
  /\d+\.?\d*\s*倍/,
  // 对比表达
  /(?:同比|环比|较去年|较上月|较上期|与去年|与上月|相比|对比|相较)/,
];

/**
 * 判断一个句子是否包含量化数据
 */
function isQuantitativeSentence(sentence: string): boolean {
  return QUANTITATIVE_PATTERNS.some((pattern) => pattern.test(sentence));
}

// ============================================================================
// 核心函数
// ============================================================================

/**
 * 从 session transcript 提取分析结论
 *
 * 策略：
 * - 扫描 assistant 消息中包含数字和数据的文本
 * - 提取含百分比、趋势描述（增长/下降）、对比的关键语句
 * - 标记 evidenceType:
 *   - 直接引用查询结果 → "direct"
 *   - 由多个结果推断 → "derived"
 *   - 解释性语句 → "hypothesis"
 * - 关联相关的 queryRef 和 chartRef
 */
export function extractFindings(params: ExtractFindingsParams): FindingEvidence[] {
  const { sessionEntries, queries, charts } = params;

  // 获取 merged transcript
  const transcript = mergeToolResults(getSessionTranscript(sessionEntries));

  // 提取所有 assistant 文本块（已通过 mergeToolResults 合并结果）
  const assistantTexts = transcript
    .filter((m) => m.role === "assistant")
    .map((m) => m.content);

  // 提取量化语句
  const quantitativeStatements: Array<{
    statement: string;
    /** 出现在哪个 assistant 消息中（索引） */
    sourceIndex: number;
  }> = [];

  for (let i = 0; i < assistantTexts.length; i++) {
    const text = assistantTexts[i];
    const sentences = splitSentences(text);

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (trimmed.length > 5 && isQuantitativeSentence(trimmed)) {
        quantitativeStatements.push({
          statement: trimmed,
          sourceIndex: i,
        });
      }
    }
  }

  // 构建 FindingEvidence
  const findings: FindingEvidence[] = [];

  for (let i = 0; i < quantitativeStatements.length; i++) {
    const { statement, sourceIndex } = quantitativeStatements[i];

    // 确定证据类型
    const evidenceType = classifyEvidenceType(statement, transcript, sourceIndex);

    // 关联查询和图表引用
    const { queryRefs, chartRefs } = findRelatedEvidence(
      statement,
      sourceIndex,
      transcript,
      queries,
      charts,
    );

    // 跳过无法关联到任何证据的语句
    if (queryRefs.length === 0 && chartRefs.length === 0) {
      // 如果没有关联到证据，且不是 hypothesis 类型，跳过
      if (evidenceType !== "hypothesis") {
        continue;
      }
    }

    // 确定置信度
    const confidence = assessConfidence(statement, evidenceType, queryRefs, chartRefs);

    // 提取 caveats
    const caveats = extractCaveats(statement);

    findings.push({
      id: `finding-extracted-${i + 1}`,
      statement,
      evidenceType,
      resultRefs: queryRefs,
      chartRefs,
      queryRefs,
      metricRefs: [],
      confidence,
      caveats,
    });
  }

  return findings;
}

// ============================================================================
// 证据类型分类
// ============================================================================

/**
 * 分类证据类型
 *
 * - direct: 语句中直接引用了查询结果的具体数字
 * - derived: 语句包含对比/推算（同比、环比、百分比计算等）
 * - hypothesis: 语句是解释性/推测性表达
 */
function classifyEvidenceType(
  statement: string,
  transcript: ReturnType<typeof mergeToolResults>,
  sourceIndex: number,
): FindingEvidence["evidenceType"] {
  // hypothesis 模式：解释性/推测性表达
  const hypothesisPatterns = [
    /可能|也许|大概|推测|猜测|估计|预计|预期|假设|应该|或许|似乎|大概|差不多/,
    /原因[是为]|因素有|导致|造成|引起|影响/,
    /建议|推荐|可以考虑|值得关注|需要注意|应该/,
  ];

  if (hypothesisPatterns.some((p) => p.test(statement))) {
    return "hypothesis";
  }

  // derived 模式：包含推算/对比表达
  const derivedPatterns = [
    /同比|环比|较去年|较上月|较上期|相比|对比|相较/,
    /增长|下降|上升|下滑|增加|减少|提升|降低/,
    /百分比|占比|比例|比率|比率/,
  ];

  if (derivedPatterns.some((p) => p.test(statement))) {
    return "derived";
  }

  // direct: 其他含量化数据的语句
  return "direct";
}

// ============================================================================
// 关联证据
// ============================================================================

/**
 * 查找与语句相关的查询和图表
 *
 * 策略：
 * 1. 查找同一 assistant 消息中前后的 toolCall（query_data / visualize）
 * 2. 通过关键词匹配（表名、列名）
 */
function findRelatedEvidence(
  _statement: string,
  sourceIndex: number,
  transcript: ReturnType<typeof mergeToolResults>,
  queries: QueryEvidence[],
  charts: ChartEvidence[],
): { queryRefs: string[]; chartRefs: string[] } {
  const queryRefs: string[] = [];
  const chartRefs: string[] = [];

  // 策略 1：查找同一 assistant 消息中的 toolCall
  // 向前查找最近的 query_data 和 visualize
  const targetMsg = transcript[sourceIndex];
  if (targetMsg?.toolCalls) {
    for (const tc of targetMsg.toolCalls) {
      if (tc.name === "query_data" && !tc.isError) {
        const queryIndex = queries.findIndex((q) => q.id.includes(tc.id) || querySqlMatches(tc.argsSummary, queries));
        if (queryIndex >= 0) {
          queryRefs.push(queries[queryIndex].id);
        }
      }
      if (tc.name === "visualize" && !tc.isError) {
        const chartIndex = charts.findIndex((c) => c.id.includes(tc.id));
        if (chartIndex >= 0) {
          chartRefs.push(charts[chartIndex].id);
        }
      }
    }
  }

  // 策略 2：查找紧邻的前一条 toolResult（数据来源）
  for (let j = sourceIndex - 1; j >= Math.max(0, sourceIndex - 5); j--) {
    const prevMsg = transcript[j];
    if (prevMsg.role === "toolResult" && prevMsg.toolName === "query_data" && !prevMsg.isError) {
      const matchingQuery = queries.find((q) => {
        // 通过 SQL 匹配
        return prevMsg.toolCallId && q.sql.length > 0;
      });
      if (matchingQuery && !queryRefs.includes(matchingQuery.id)) {
        queryRefs.push(matchingQuery.id);
      }
      break; // 只关联最近的一条
    }
  }

  return {
    queryRefs: [...new Set(queryRefs)],
    chartRefs: [...new Set(chartRefs)],
  };
}

/**
 * 通过 argsSummary 中的 SQL 匹配查询
 */
function querySqlMatches(argsSummary: string, queries: QueryEvidence[]): boolean {
  try {
    const args = JSON.parse(argsSummary);
    const sql = String(args.sql ?? "").toLowerCase().replace(/\s+/g, " ");
    return queries.some(
      (q) => q.sql.toLowerCase().replace(/\s+/g, " ") === sql
    );
  } catch {
    return false;
  }
}

// ============================================================================
// 置信度评估
// ============================================================================

/**
 * 评估语句的置信度
 *
 * - high: 直接引用查询结果，有明确的数字来源
 * - medium: 推导/对比结论，基于多个数据源
 * - low: 假设/推测性表达
 */
function assessConfidence(
  statement: string,
  evidenceType: FindingEvidence["evidenceType"],
  queryRefs: string[],
  chartRefs: string[],
): FindingEvidence["confidence"] {
  if (evidenceType === "hypothesis") {
    return "low";
  }

  if (evidenceType === "derived") {
    return queryRefs.length > 1 || chartRefs.length > 0 ? "medium" : "low";
  }

  // direct 类型
  if (queryRefs.length > 0 || chartRefs.length > 0) {
    return "high";
  }

  return "medium";
}

// ============================================================================
// Caveat 提取
// ============================================================================

/**
 * 提取语句中的注意事项/前提条件
 */
function extractCaveats(statement: string): string[] {
  const caveats: string[] = [];

  const caveatPatterns = [
    { pattern: /注意[：:]/, label: "注意" },
    { pattern: /需要[注意|关注|警惕]/, label: "需要关注" },
    { pattern: /可能[存在|有|会]/, label: "可能性" },
    { pattern: /仅供参考/, label: "仅供参考" },
    { pattern: /数据[可能|可能存在].*问题/, label: "数据问题" },
  ];

  for (const { pattern, label } of caveatPatterns) {
    if (pattern.test(statement)) {
      caveats.push(label);
    }
  }

  return caveats;
}

// ============================================================================
// 文本分割
// ============================================================================

/**
 * 将文本按句子分割
 *
 * 支持中文句号、问号、感叹号、分号以及换行符分割。
 */
function splitSentences(text: string): string[] {
  // 按句子结束符分割，保留分隔符前的文本
  const raw = text.split(/(?<=[。？！；\n.!?])\s*/);
  return raw
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
