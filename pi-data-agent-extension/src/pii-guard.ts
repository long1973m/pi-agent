/**
 * S5.2 PII Guard — 最小脱敏模块
 *
 * 职责：
 * 1. 检测样本数据中的 PII（email / phone / id_card）
 * 2. 替换为脱敏标记（不改变 DuckDB 原始数据）
 * 3. 仅作用于进入 prompt / 样本展示的文本
 *
 * 设计原则：
 * - 纯正则，零外部依赖
 * - 仅覆盖中国身份证、手机号、国际邮箱三种高频 PII
 * - 脱敏失败不影响主流程
 */

/** PII 类型 */
export type PIIType = "email" | "phone" | "id_card";

/** 单条 PII 检测结果 */
export interface PIIMatch {
  type: PIIType;
  original: string;
  masked: string;
}

// ============================================================================
// 正则规则
// ============================================================================

const PII_RULES: Array<{ type: PIIType; pattern: RegExp; mask: (match: string) => string }> = [
  {
    // 中国大陆身份证号：18 位，最后一位可能为 X
    type: "id_card",
    pattern: /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
    mask: (m) => m.slice(0, 6) + "******" + m.slice(-4),
  },
  {
    // 中国大陆手机号：1 开头 11 位
    type: "phone",
    pattern: /\b1[3-9]\d{9}\b/g,
    mask: (m) => m.slice(0, 3) + "****" + m.slice(-4),
  },
  {
    // 国际邮箱
    type: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    mask: (m) => {
      const [local, domain] = m.split("@");
      const maskedLocal = local.length <= 2 ? local[0] + "***" : local[0] + "***" + local[local.length - 1];
      return `${maskedLocal}@${domain}`;
    },
  },
];

// ============================================================================
// 核心函数
// ============================================================================

/**
 * 检测并脱敏单条文本
 *
 * @param text 原始文本
 * @returns { masked: 脱敏后文本, matches: 检测到的 PII 列表 }
 */
export function maskPII(text: string): { masked: string; matches: PIIMatch[] } {
  if (!text || typeof text !== "string") return { masked: text, matches: [] };

  const matches: PIIMatch[] = [];
  let result = text;

  for (const rule of PII_RULES) {
    // 每条规则独立匹配：先收集所有 match，再从后往前替换（避免索引偏移）
    const ruleMatches: Array<{ index: number; length: number; original: string }> = [];
    const scanRegex = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = scanRegex.exec(result)) !== null) {
      ruleMatches.push({ index: m.index, length: m[0].length, original: m[0] });
    }

    // 从后往前替换（保持前面索引有效）
    for (let i = ruleMatches.length - 1; i >= 0; i--) {
      const { index, length, original } = ruleMatches[i];
      const masked = rule.mask(original);
      matches.push({ type: rule.type, original, masked });
      result = result.slice(0, index) + masked + result.slice(index + length);
    }
  }

  return { masked: result, matches };
}

/**
 * 检测文本是否包含 PII（不执行替换）
 */
export function detectPII(text: string): PIIMatch[] {
  if (!text || typeof text !== "string") return [];

  const matches: PIIMatch[] = [];
  for (const rule of PII_RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      matches.push({ type: rule.type, original: match[0], masked: rule.mask(match[0]) });
    }
  }
  return matches;
}

/**
 * 批量脱敏字符串数组
 */
export function maskPIIArray(values: string[]): { masked: string[]; totalMatches: number } {
  let totalMatches = 0;
  const masked = values.map((v) => {
    const result = maskPII(v);
    totalMatches += result.matches.length;
    return result.masked;
  });
  return { masked, totalMatches };
}
