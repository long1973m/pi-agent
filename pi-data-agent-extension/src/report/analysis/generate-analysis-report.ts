/**
 * Task 3 & 4 — 分析报告生成主流程
 *
 * 串联完整管线：
 * 1. 构建 Evidence Package
 * 2. 检查证据充分性
 * 3. 提取 Finding
 * 4. 构建 prompt 调用模型生成 Report Draft JSON
 * 5. JSON 解析 + schema 校验（失败重试一次）
 * 6. 运行质量门槛
 * 7. 质量门槛通过 -> 渲染 HTML
 * 8. 写入报告文件 + Evidence Package JSON
 * 9. 返回结果
 *
 * 关键约束：
 * - 证据不足时不生成伪完整报告（Spec S4.1）
 * - JSON 解析失败重试一次，schema 不合法定向修复一次
 * - 引用了不存在的 evidence ID 时拒绝渲染
 * - 两次失败保留 Evidence Package，报告失败原因
 * - 模型调用通过依赖注入（callModel 参数）
 */

import type { EvidencePackage, ReportMode } from "../evidence/types.js";
import type { DataDictionaryEntry } from "../../types.js";
import type { AnalysisReportDraft } from "./report-draft-schema.js";
import type { QualityGateResult } from "./report-quality-gate.js";
import { buildEvidencePackage } from "../evidence/build-evidence-package.js";
import type { BuildEvidenceParams } from "../evidence/build-evidence-package.js";
import { extractFindings } from "../evidence/finding-extractor.js";
import type { ExtractFindingsParams } from "../evidence/finding-extractor.js";
import {
  validateEvidencePackage,
  checkEvidenceSufficiency,
} from "../evidence/evidence-validator.js";
import { validateReportDraft, attemptSchemaRepair } from "./report-draft-schema.js";
import { runQualityGate } from "./report-quality-gate.js";
import { renderAnalysisReport } from "./render-analysis-report.js";
import type { RenderAnalysisReportParams } from "./render-analysis-report.js";
import type { SessionEntry } from "../session-transcript.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ============================================================================
// 参数类型
// ============================================================================

export interface GenerateAnalysisReportParams {
  /** Session entries */
  sessionEntries: Array<{
    type: string;
    id: string;
    parentId: string | null;
    timestamp: string;
    message?: unknown;
  }>;
  /** Session ID（用于命名和关联） */
  sessionId: string;
  /** 报告模式 */
  reportMode: ReportMode;
  /** 数据字典快照 */
  dictionaryEntries: DataDictionaryEntry[];
  /** 口径列表 */
  calibers: Array<{
    id: string;
    question: string;
    definition: string;
    confirmedAt: string;
  }>;
  /** 查询记忆 */
  queryMemory: Array<{
    id: string;
    naturalLanguageQuery: string;
    sql: string;
    timestamp: string;
    resultSummary?: string;
  }>;
  /** reports 目录 */
  reportsDir: string;
  /** 来源 session report ID */
  sourceSessionReportId: string;
  /** 模型调用函数（依赖注入） */
  callModel?: (prompt: string, responseFormat?: object) => Promise<string>;
}

export interface GenerateAnalysisReportResult {
  success: boolean;
  reportPath?: string;
  evidencePath?: string;
  reportId?: string;
  error?: string;
  qualityGate?: QualityGateResult;
  /** 证据不足时的缺失项 */
  missingItems?: string[];
  /** 证据包（成功时返回，供调用方提取 datasets/charts 写入 manifest） */
  evidence?: EvidencePackage;
}

// ============================================================================
// 核心流程
// ============================================================================

/**
 * 生成分析报告完整流程
 */
export async function generateAnalysisReport(
  params: GenerateAnalysisReportParams
): Promise<GenerateAnalysisReportResult> {
  const {
    sessionEntries,
    sessionId,
    reportMode,
    dictionaryEntries,
    calibers,
    queryMemory,
    reportsDir,
    sourceSessionReportId,
    callModel,
  } = params;

  // 生成 report ID
  const reportId = `analysis-${sessionId}-${Date.now()}`;

  // ========================================================================
  // Step 1: 构建 Evidence Package
  // ========================================================================
  let evidence: EvidencePackage;

  try {
    // 从 session entries 中提取第一条用户消息作为 question
    const question = extractFirstUserQuestion(sessionEntries);

    const buildParams: BuildEvidenceParams = {
      sessionEntries: sessionEntries as SessionEntry[],
      sessionId,
      question,
      reportMode,
      dictionaryEntries,
      calibers,
      queryMemory,
      reportsDir,
    };

    evidence = buildEvidencePackage(buildParams);
  } catch (err) {
    return {
      success: false,
      reportId,
      error: `Failed to build evidence package: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ========================================================================
  // Step 2: 校验 Evidence Package
  // ========================================================================
  const validation = validateEvidencePackage(evidence);
  if (!validation.valid) {
    // 即使校验失败也保存 evidence package
    await saveEvidencePackage(evidence, reportId, reportsDir).catch(() => {});
    return {
      success: false,
      reportId,
      error: `Evidence package validation failed: ${validation.errors.join("; ")}`,
      evidencePath: join(reportsDir, "evidence", `${reportId}.json`),
    };
  }

  // ========================================================================
  // Step 3: 检查证据充分性
  // ========================================================================
  const missingItems = checkEvidenceSufficiency(evidence);
  if (missingItems.length > 0) {
    // 证据不足：不生成伪完整报告（Spec S4.1），保留 Evidence Package
    await saveEvidencePackage(evidence, reportId, reportsDir).catch(() => {});
    return {
      success: false,
      reportId,
      error: "Insufficient evidence to generate report",
      missingItems,
      evidencePath: join(reportsDir, "evidence", `${reportId}.json`),
    };
  }

  // ========================================================================
  // Step 4: 提取 Finding
  // ========================================================================
  try {
    const extractParams: ExtractFindingsParams = {
      sessionEntries: sessionEntries as SessionEntry[],
      queries: evidence.queries,
      charts: evidence.charts,
    };

    const extractedFindings = extractFindings(extractParams);

    // 合并到 evidence（补充而非覆盖）
    if (extractedFindings.length > 0 && evidence.findings.length === 0) {
      evidence = {
        ...evidence,
        findings: extractedFindings,
      };
    }
  } catch (err) {
    // Finding 提取失败不阻塞流程（模型生成时可自行产生 findings）
    console.warn(
      `[generateAnalysisReport] Finding extraction warning: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ========================================================================
  // Step 5: 检查 callModel
  // ========================================================================
  if (!callModel) {
    // 保留 evidence package
    await saveEvidencePackage(evidence, reportId, reportsDir).catch(() => {});
    return {
      success: false,
      reportId,
      error: "AI 模型未配置（callModel 未注入）",
      evidencePath: join(reportsDir, "evidence", `${reportId}.json`),
    };
  }

  // ========================================================================
  // Step 6: 调用模型生成 Report Draft
  // ========================================================================
  let draft: AnalysisReportDraft | null = null;

  try {
    const prompt = buildModelPrompt(evidence, reportMode);
    let rawResponse = "";

    // 首次尝试
    try {
      rawResponse = await callModel(prompt, {
        type: "json_schema",
        json_schema: {
          name: "AnalysisReportDraft",
          strict: true,
          schema: DRAFT_JSON_SCHEMA,
        },
      });
    } catch (modelErr) {
      // 首次调用失败，不使用 responseFormat 重试一次
      try {
        console.warn(
          `[generateAnalysisReport] First model call failed, retrying without structured output: ${modelErr instanceof Error ? modelErr.message : String(modelErr)}`
        );
        rawResponse = await callModel(prompt);
      } catch {
        throw new Error(
          `Model call failed after retry: ${modelErr instanceof Error ? modelErr.message : String(modelErr)}`
        );
      }
    }

    // JSON 解析 + schema 校验（失败重试一次）
    draft = parseAndValidateDraft(rawResponse);
  } catch (err) {
    // 保留 evidence package
    await saveEvidencePackage(evidence, reportId, reportsDir).catch(() => {});
    return {
      success: false,
      reportId,
      error: `Failed to generate report draft: ${err instanceof Error ? err.message : String(err)}`,
      evidencePath: join(reportsDir, "evidence", `${reportId}.json`),
    };
  }

  if (!draft) {
    await saveEvidencePackage(evidence, reportId, reportsDir).catch(() => {});
    return {
      success: false,
      reportId,
      error: "Failed to parse model output into valid report draft",
      evidencePath: join(reportsDir, "evidence", `${reportId}.json`),
    };
  }

  // ========================================================================
  // Step 7: 运行质量门槛
  // ========================================================================
  const qualityGate = runQualityGate(draft, evidence);

  if (!qualityGate.passed) {
    // 质量门槛未通过：保留 evidence + draft，不渲染
    await saveEvidencePackage(evidence, reportId, reportsDir).catch(() => {});
    return {
      success: false,
      reportId,
      error: `Quality gate failed: ${qualityGate.errors.join("; ")}`,
      qualityGate,
      evidencePath: join(reportsDir, "evidence", `${reportId}.json`),
    };
  }

  // ========================================================================
  // Step 8: 渲染 HTML
  // ========================================================================
  let html: string;
  try {
    const renderParams: RenderAnalysisReportParams = {
      draft,
      evidence,
      reportId,
      sourceSessionReportId,
      sourceSessionId: sessionId,
      generatedAt: new Date().toISOString(),
      reportsDir,
    };

    const renderResult = renderAnalysisReport(renderParams);
    html = renderResult.html;
  } catch (err) {
    await saveEvidencePackage(evidence, reportId, reportsDir).catch(() => {});
    return {
      success: false,
      reportId,
      error: `Failed to render HTML: ${err instanceof Error ? err.message : String(err)}`,
      qualityGate,
      evidencePath: join(reportsDir, "evidence", `${reportId}.json`),
    };
  }

  // ========================================================================
  // Step 9: 写入文件
  // ========================================================================
  try {
    // 确保 reports 目录和 evidence 子目录存在
    await mkdir(join(reportsDir, "evidence"), { recursive: true });

    // 写入 HTML 报告（使用 reportId 中的同一时间戳，保证一致）
    const reportFileName = `${reportId}.html`;
    const reportPath = join(reportsDir, reportFileName);
    await writeFile(reportPath, html, "utf-8");

    // 写入 Evidence Package JSON
    const evidencePath = join(reportsDir, "evidence", `${reportId}.json`);
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf-8");

    return {
      success: true,
      reportPath,
      evidencePath,
      reportId,
      qualityGate,
      evidence,
    };
  } catch (err) {
    return {
      success: false,
      reportId,
      error: `Failed to write report files: ${err instanceof Error ? err.message : String(err)}`,
      qualityGate,
    };
  }
}

// ============================================================================
// 模型 Prompt 构建
// ============================================================================

/**
 * 构建模型 prompt（Spec S6.1）
 *
 * System prompt 约束：
 * - 只能引用 Evidence Package 中的信息
 * - 不得创造新数字
 * - hypothesis 必须标注
 */
function buildModelPrompt(
  evidence: EvidencePackage,
  reportMode: ReportMode
): string {
  const evidenceJson = JSON.stringify(evidence, null, 2);

  const executiveConstraint =
    reportMode === "executive"
      ? `
EXECUTIVE MODE: Generate a concise executive report.
- Executive summary: Exactly 3 core conclusions (no more, no less)
- Sections: Focus on the most critical findings only
- Keep the total report under 2000 words
- Omit detailed analysis; each section should be 2-3 sentences max
`
      : `
DETAILED MODE: Generate a comprehensive analysis report.
- Executive summary: Up to 5 core conclusions
- Sections: Cover all significant findings with full detail
- Include thorough interpretations and evidence traceability
`;

  return `You are a professional data analyst generating a structured analysis report.

ROLE: Transform the provided Evidence Package into a clear, evidence-based analysis report.

CONSTRAINTS (MUST follow):
1. ONLY reference information that exists in the Evidence Package. Do NOT invent data, numbers, or conclusions.
2. Every quantitative claim must be traceable to a specific query result or finding in the Evidence Package.
3. If a conclusion is a hypothesis or speculation (not directly supported by data), you MUST mark interpretationType as "hypothesis".
4. Hypotheses MUST be listed in the limitations section.
5. Preserve ALL high-severity limitations from the Evidence Package in your limitations list.
6. Use the exact evidence IDs from the Evidence Package when referencing them.
7. Do NOT add new data sources, datasets, or time ranges that are not in the Evidence Package scope.
8. All findingRefs, evidenceRefs, and chartRefs must be valid IDs from the Evidence Package.

${executiveConstraint}

OUTPUT FORMAT: Return a JSON object with this exact structure:
{
  "title": "Report title",
  "executiveSummary": [
    { "text": "Core conclusion text", "findingRefs": ["finding-id-1"] }
  ],
  "background": "Analysis background and context",
  "scope": "Data scope and business calibers used",
  "sections": [
    {
      "heading": "Section title",
      "conclusion": "Key finding or conclusion",
      "evidenceRefs": ["query-1", "finding-extracted-1"],
      "chartRefs": ["chart-1"],
      "interpretation": "Detailed interpretation (optional)",
      "interpretationType": "supported" | "hypothesis"
    }
  ],
  "recommendations": [
    {
      "action": "Recommended action",
      "priority": "high" | "medium" | "low",
      "rationale": "Why this action is recommended",
      "findingRefs": ["finding-id-1"]
    }
  ],
  "limitations": [
    "Limitation description as string"
  ]
}

EVIDENCE PACKAGE:
${evidenceJson}

Generate the analysis report JSON now.`;
}

/**
 * JSON Schema for structured output
 */
const DRAFT_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    executiveSummary: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          findingRefs: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["text", "findingRefs"],
      },
    },
    background: { type: "string" },
    scope: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          conclusion: { type: "string" },
          evidenceRefs: {
            type: "array",
            items: { type: "string" },
          },
          chartRefs: {
            type: "array",
            items: { type: "string" },
          },
          interpretation: { type: "string" },
          interpretationType: {
            type: "string",
            enum: ["supported", "hypothesis"],
          },
        },
        required: ["heading", "conclusion", "evidenceRefs", "chartRefs"],
      },
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string" },
          priority: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
          rationale: { type: "string" },
          findingRefs: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["action", "priority", "rationale", "findingRefs"],
      },
    },
    limitations: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["title", "executiveSummary", "background", "scope", "sections", "recommendations", "limitations"],
};

// ============================================================================
// JSON 解析与 Schema 校验
// ============================================================================

/** 清理非标准JSON字符串，支持注释、尾随逗号、单引号 */
function sanitizeJsonString(jsonStr: string): string {
  try {
    return jsonStr
      .replace(/\/\/.*$/gm, "") // 移除单行注释
      .replace(/\/\*[\s\S]*?\*\//g, "") // 移除多行注释
      .replace(/,\s*([}\]])/g, "$1") // 移除对象/数组尾随逗号
      .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":') // 无引号或单引号key转双引号
      .replace(/:\s*'([^']*)'/g, ': "$1")') // 单引号value转双引号
      .trim();
  } catch (err) {
    console.warn(`[generateAnalysisReport] JSON sanitization error: ${err}`);
    return jsonStr;
  }
}

/**
 * 解析模型输出并校验 schema
 *
 * 策略：
 * 1. 清理非标准JSON格式（注释、尾随逗号、单引号）
 * 2. 尝试直接 JSON.parse
 * 3. 尝试从 markdown 代码块中提取 JSON
 * 4. schema 校验失败 -> attemptSchemaRepair 修复一次
 * 5. 修复后再校验 -> 仍失败则抛错
 */
function parseAndValidateDraft(
  rawResponse: string
): AnalysisReportDraft | null {
  let parsed: unknown = null;
  let jsonStr = rawResponse.trim();

  // 步骤1：清理非标准JSON
  jsonStr = sanitizeJsonString(jsonStr);

  // 策略 1: 直接解析
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // 策略 2: 从 markdown 代码块中提取
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      let extractedStr = sanitizeJsonString(codeBlockMatch[1].trim());
      try {
        parsed = JSON.parse(extractedStr);
      } catch {
        // 策略 3: 找到第一个 { 和最后一个 } 之间的内容
        const firstBrace = extractedStr.indexOf("{");
        const lastBrace = extractedStr.lastIndexOf("}");
        if (firstBrace >= 0 && lastBrace > firstBrace) {
          extractedStr = sanitizeJsonString(extractedStr.slice(firstBrace, lastBrace + 1));
          try {
            parsed = JSON.parse(extractedStr);
          } catch {
            return null;
          }
        }
      }
    }
  }

  if (!parsed) return null;

  // Schema 校验
  const validation = validateReportDraft(parsed);
  if (validation.valid) {
    return parsed as AnalysisReportDraft;
  }

  // Schema 不合法 -> 定向修复一次
  console.warn(
    `[generateAnalysisReport] Schema validation failed, attempting repair: ${validation.errors.join("; ")}`
  );

  try {
    const { repaired, changed } = attemptSchemaRepair(
      parsed as Record<string, unknown>
    );

    if (changed) {
      const repairValidation = validateReportDraft(repaired);
      if (repairValidation.valid) {
        console.log("[generateAnalysisReport] Schema repair successful");
        return repaired;
      }
      console.warn(
        `[generateAnalysisReport] Schema repair failed: ${repairValidation.errors.join("; ")}`
      );
    }
  } catch (repairErr) {
    console.warn(
      `[generateAnalysisReport] Schema repair error: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`
    );
  }

  return null;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从 session entries 中提取第一条用户消息
 */
function extractFirstUserQuestion(
  entries: Array<{
    type: string;
    id: string;
    parentId: string | null;
    timestamp: string;
    message?: unknown;
  }>
): string {
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      const msg = entry.message as {
        role: string;
        content: string | Array<{ type: string; text?: string }>;
      };
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          return msg.content;
        }
        if (Array.isArray(msg.content)) {
          const textBlock = msg.content.find((b) => b.type === "text");
          if (textBlock?.text) return textBlock.text;
        }
      }
    }
  }
  return "Analysis Report";
}

/**
 * 保存 Evidence Package 到 JSON 文件
 */
async function saveEvidencePackage(
  evidence: EvidencePackage,
  reportId: string,
  reportsDir: string
): Promise<void> {
  try {
    await mkdir(join(reportsDir, "evidence"), { recursive: true });
    const evidencePath = join(reportsDir, "evidence", `${reportId}.json`);
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf-8");
  } catch (err) {
    console.warn(
      `[generateAnalysisReport] Failed to save evidence package: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
