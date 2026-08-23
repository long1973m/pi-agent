/**
 * Task 3 — Report Draft 结构定义与校验
 *
 * AnalysisReportDraft 是模型输出的结构化报告草稿 JSON。
 * 定义了标题、执行摘要、背景、范围、分析章节、建议和限制。
 *
 * Spec §6.1 约束：
 * - 只能引用 Evidence Package 中的信息
 * - 不得创造新数字
 * - hypothesis 必须标注 interpretationType
 */

// ============================================================================
// Report Draft 结构定义
// ============================================================================

/** 执行摘要条目 */
export interface ExecutiveSummaryItem {
  /** 核心结论文本 */
  text: string;
  /** 关联的 finding 引用 ID 列表 */
  findingRefs: string[];
}

/** 分析章节 */
export interface AnalysisSection {
  /** 章节标题 */
  heading: string;
  /** 核心结论 */
  conclusion: string;
  /** 关联的证据引用 ID 列表 */
  evidenceRefs: string[];
  /** 关联的图表引用 ID 列表 */
  chartRefs: string[];
  /** 详细解读（可选） */
  interpretation?: string;
  /** 解读类型：supported（有直接证据）或 hypothesis（推测） */
  interpretationType?: "supported" | "hypothesis";
}

/** 行动建议 */
export interface Recommendation {
  /** 建议动作 */
  action: string;
  /** 优先级 */
  priority: "high" | "medium" | "low";
  /** 理由 */
  rationale: string;
  /** 关联的 finding 引用 ID 列表 */
  findingRefs: string[];
}

/** 分析报告草稿（模型输出） */
export interface AnalysisReportDraft {
  /** 报告标题 */
  title: string;
  /** 执行摘要（至少 1 条） */
  executiveSummary: ExecutiveSummaryItem[];
  /** 分析背景 */
  background: string;
  /** 数据范围与口径 */
  scope: string;
  /** 分析章节（可空） */
  sections: AnalysisSection[];
  /** 行动建议（可空） */
  recommendations: Recommendation[];
  /** 风险、限制与待验证事项（可空） */
  limitations: string[];
}

// ============================================================================
// Schema 校验
// ============================================================================

const VALID_PRIORITIES = new Set<string>(["high", "medium", "low"]);
const VALID_INTERPRETATION_TYPES = new Set<string>(["supported", "hypothesis"]);

/**
 * 校验 Report Draft JSON 结构
 *
 * 校验项：
 * - title 非空
 * - executiveSummary 至少 1 条，每条 text 非空
 * - sections 数组（可空）
 * - recommendations 数组（可空），每条 action 非空，priority 枚举
 * - limitations 数组（可空）
 */
export function validateReportDraft(
  draft: unknown
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // 基础类型检查
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    errors.push("Report draft must be a non-null object");
    return { valid: false, errors };
  }

  const d = draft as Record<string, unknown>;

  // 1. title 非空
  if (typeof d.title !== "string" || d.title.trim().length === 0) {
    errors.push("title must be a non-empty string");
  }

  // 2. executiveSummary 至少 1 条，每条 text 非空
  if (!Array.isArray(d.executiveSummary)) {
    errors.push("executiveSummary must be an array");
  } else {
    if (d.executiveSummary.length === 0) {
      errors.push("executiveSummary must contain at least 1 item");
    }
    for (let i = 0; i < d.executiveSummary.length; i++) {
      const item = d.executiveSummary[i];
      if (!item || typeof item !== "object") {
        errors.push(`executiveSummary[${i}] must be an object`);
        continue;
      }
      const es = item as Record<string, unknown>;
      if (typeof es.text !== "string" || (es.text as string).trim().length === 0) {
        errors.push(`executiveSummary[${i}].text must be a non-empty string`);
      }
      // findingRefs 可选但必须是数组
      if (es.findingRefs !== undefined && !Array.isArray(es.findingRefs)) {
        errors.push(`executiveSummary[${i}].findingRefs must be an array`);
      }
    }
  }

  // 3. sections 数组（可空）
  if (d.sections !== undefined && !Array.isArray(d.sections)) {
    errors.push("sections must be an array (can be empty)");
  } else if (Array.isArray(d.sections)) {
    for (let i = 0; i < d.sections.length; i++) {
      const section = d.sections[i];
      if (!section || typeof section !== "object") {
        errors.push(`sections[${i}] must be an object`);
        continue;
      }
      const s = section as Record<string, unknown>;
      if (typeof s.heading !== "string" || (s.heading as string).trim().length === 0) {
        errors.push(`sections[${i}].heading must be a non-empty string`);
      }
      if (typeof s.conclusion !== "string" || (s.conclusion as string).trim().length === 0) {
        errors.push(`sections[${i}].conclusion must be a non-empty string`);
      }
      // evidenceRefs 和 chartRefs 可选但必须是数组
      if (s.evidenceRefs !== undefined && !Array.isArray(s.evidenceRefs)) {
        errors.push(`sections[${i}].evidenceRefs must be an array`);
      }
      if (s.chartRefs !== undefined && !Array.isArray(s.chartRefs)) {
        errors.push(`sections[${i}].chartRefs must be an array`);
      }
      // interpretationType 枚举检查
      if (
        s.interpretationType !== undefined &&
        !VALID_INTERPRETATION_TYPES.has(s.interpretationType as string)
      ) {
        errors.push(
          `sections[${i}].interpretationType must be "supported" or "hypothesis", got "${s.interpretationType}"`
        );
      }
    }
  }

  // 4. recommendations 数组（可空），每条 action 非空，priority 枚举
  if (d.recommendations !== undefined && !Array.isArray(d.recommendations)) {
    errors.push("recommendations must be an array (can be empty)");
  } else if (Array.isArray(d.recommendations)) {
    for (let i = 0; i < d.recommendations.length; i++) {
      const rec = d.recommendations[i];
      if (!rec || typeof rec !== "object") {
        errors.push(`recommendations[${i}] must be an object`);
        continue;
      }
      const r = rec as Record<string, unknown>;
      if (typeof r.action !== "string" || (r.action as string).trim().length === 0) {
        errors.push(`recommendations[${i}].action must be a non-empty string`);
      }
      if (!VALID_PRIORITIES.has(r.priority as string)) {
        errors.push(
          `recommendations[${i}].priority must be "high", "medium", or "low", got "${r.priority}"`
        );
      }
      if (typeof r.rationale !== "string" || (r.rationale as string).trim().length === 0) {
        errors.push(`recommendations[${i}].rationale must be a non-empty string`);
      }
      // findingRefs 可选但必须是数组
      if (r.findingRefs !== undefined && !Array.isArray(r.findingRefs)) {
        errors.push(`recommendations[${i}].findingRefs must be an array`);
      }
    }
  }

  // 5. limitations 数组（可空）
  if (d.limitations !== undefined && !Array.isArray(d.limitations)) {
    errors.push("limitations must be an array (can be empty)");
  }

  // 6. background 和 scope 应该是字符串
  if (d.background !== undefined && typeof d.background !== "string") {
    errors.push("background must be a string");
  }
  if (d.scope !== undefined && typeof d.scope !== "string") {
    errors.push("scope must be a string");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 定向修复常见的 JSON schema 问题
 *
 * 在模型输出 JSON schema 不完全合规时，尝试修复：
 * - 缺少必要字段：补默认值
 * - 字段类型错误：尝试强制转换
 * - 枚举值不合法：映射到最近的合法值
 *
 * @returns 修复后的 draft 和是否进行了修复
 */
export function attemptSchemaRepair(
  draft: AnalysisReportDraft | Record<string, unknown>
): { repaired: AnalysisReportDraft; changed: boolean } {
  let changed = false;
  const result = { ...draft } as Record<string, unknown>;

  // 修复 title
  if (typeof result.title !== "string" || (result.title as string).trim().length === 0) {
    result.title = "Analysis Report";
    changed = true;
  }

  // 修复 executiveSummary
  if (!Array.isArray(result.executiveSummary) || result.executiveSummary.length === 0) {
    result.executiveSummary = [{ text: "No executive summary generated.", findingRefs: [] }];
    changed = true;
  } else {
    const repairedSummary = (result.executiveSummary as Array<Record<string, unknown>>).map((item) => ({
      text: typeof item.text === "string" ? item.text : "Summary point",
      findingRefs: Array.isArray(item.findingRefs) ? item.findingRefs : [],
    }));
    if (JSON.stringify(repairedSummary) !== JSON.stringify(result.executiveSummary)) {
      result.executiveSummary = repairedSummary;
      changed = true;
    }
  }

  // 修复 sections
  if (result.sections !== undefined && !Array.isArray(result.sections)) {
    result.sections = [];
    changed = true;
  }

  // 修复 recommendations
  if (result.recommendations !== undefined) {
    if (!Array.isArray(result.recommendations)) {
      result.recommendations = [];
      changed = true;
    } else {
      const repairedRecs = (result.recommendations as Array<Record<string, unknown>>).map((rec) => {
        const repaired = { ...rec };
        if (typeof repaired.action !== "string") {
          repaired.action = String(repaired.action ?? "");
          changed = true;
        }
        if (!VALID_PRIORITIES.has(repaired.priority as string)) {
          repaired.priority = "medium";
          changed = true;
        }
        if (typeof repaired.rationale !== "string") {
          repaired.rationale = String(repaired.rationale ?? "");
          changed = true;
        }
        if (!Array.isArray(repaired.findingRefs)) {
          repaired.findingRefs = [];
          changed = true;
        }
        return repaired;
      });
      if (JSON.stringify(repairedRecs) !== JSON.stringify(result.recommendations)) {
        result.recommendations = repairedRecs;
        changed = true;
      }
    }
  } else {
    result.recommendations = [];
    changed = true;
  }

  // 修复 limitations
  if (result.limitations !== undefined && !Array.isArray(result.limitations)) {
    result.limitations = [];
    changed = true;
  } else if (result.limitations === undefined) {
    result.limitations = [];
    changed = true;
  }

  // 修复 background 和 scope
  if (result.background === undefined) {
    result.background = "";
    changed = true;
  }
  if (result.scope === undefined) {
    result.scope = "";
    changed = true;
  }

  return { repaired: result as unknown as AnalysisReportDraft, changed };
}
