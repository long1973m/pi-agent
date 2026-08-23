/**
 * Task 1 — 会话消息读取与整理
 *
 * 从 SessionManager.getBranch() 返回的 entries 中提取消息流，
 * 过滤掉非消息类型（thinking_level_change / model_change / compaction / branch_summary 等），
 * 只保留 type: "message" 的 entries。
 *
 * 从 AgentMessage 中提取：
 * - role: user / assistant / toolResult / bashExecution / custom / branchSummary / compactionSummary
 * - content: 文本内容
 * - timestamp: 时间戳
 * - toolCalls?: 工具调用信息（工具名、参数摘要、结果摘要）
 */

// ============================================================================
// 类型定义（与 SDK session-format.md 对齐，不直接依赖未展开的包）
// ============================================================================

/** 内容块类型 */
interface TextBlock {
  type: "text";
  text: string;
}

interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

type ContentBlock = TextBlock | ImageBlock | ToolCallBlock | ThinkingBlock;

/** 基础消息 */
interface BaseMessage {
  role: string;
  timestamp: number;
}

/** 用户消息 */
interface UserMessage extends BaseMessage {
  role: "user";
  content: string | ContentBlock[];
}

/** 助手消息 */
interface AssistantMessage extends BaseMessage {
  role: "assistant";
  content: ContentBlock[];
  api?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

/** 工具结果消息 */
interface ToolResultMessage extends BaseMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextBlock | ImageBlock)[];
  details?: unknown;
  isError: boolean;
}

/** Bash 执行消息 */
interface BashExecutionMessage extends BaseMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
}

/** 自定义消息 */
interface CustomMessage extends BaseMessage {
  role: "custom";
  customType: string;
  content: string | ContentBlock[];
  display: boolean;
}

/** Branch 摘要消息 */
interface BranchSummaryMessage extends BaseMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
}

/** Compaction 摘要消息 */
interface CompactionSummaryMessage extends BaseMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
}

type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;

/** Session entry base */
interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

/** Session message entry */
interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

/** 通用 session entry（过滤用） */
export interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: AgentMessage;
}

// ============================================================================
// Transcript 类型
// ============================================================================

/** 工具调用摘要 */
export interface ToolCallInfo {
  /** 工具调用 ID */
  id: string;
  /** 工具名 */
  name: string;
  /** 参数摘要（截断到 200 字符） */
  argsSummary: string;
  /** 结果摘要（截断到 500 字符） */
  resultSummary: string;
  /** 是否出错 */
  isError: boolean;
}

/** 单条 transcript 消息 */
export interface TranscriptMessage {
  /** 消息角色 */
  role: string;
  /** 文本内容（聚合所有 TextBlock） */
  content: string;
  /** 时间戳（ISO string） */
  timestamp: string;
  /** 入口 ID（用于锚点） */
  entryId: string;
  /** 工具调用信息（仅 assistant 消息可能有） */
  toolCalls?: ToolCallInfo[];
  /** 是否为错误状态 */
  isError?: boolean;
  /** 工具调用 ID（仅 toolResult 消息，用于精确匹配） */
  toolCallId?: string;
  /** 工具名（仅 toolResult 消息） */
  toolName?: string;
}

// ============================================================================
// 核心函数
// ============================================================================

/** 参数摘要最大长度 */
const MAX_ARGS_SUMMARY = 200;
/** 结果摘要最大长度 */
const MAX_RESULT_SUMMARY = 500;

/**
 * 从 SessionManager.getBranch() 的结果中提取 transcript
 *
 * @param entries - getBranch() 返回的所有 entries
 * @returns 过滤并整理后的 transcript 数组
 */
export function getSessionTranscript(entries: SessionEntry[]): TranscriptMessage[] {
  return entries
    .filter((entry): entry is SessionMessageEntry => entry.type === "message" && !!entry.message)
    .map((entry): TranscriptMessage => {
      const msg = entry.message!;
      const base = {
        timestamp: entry.timestamp,
        entryId: entry.id,
      };

      switch (msg.role) {
        case "user":
          return {
            role: "user",
            content: extractTextFromUser(msg),
            ...base,
          };

        case "assistant":
          return {
            role: "assistant",
            content: extractTextFromAssistant(msg),
            toolCalls: extractToolCallsFromAssistant(msg),
            ...base,
          };

        case "toolResult":
          return {
            role: "toolResult",
            content: extractTextFromToolResult(msg),
            isError: msg.isError,
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            ...base,
          };

        case "bashExecution":
          return {
            role: "bashExecution",
            content: `[Bash] ${msg.command}\n${truncate(msg.output, MAX_RESULT_SUMMARY)}`,
            isError: (msg.exitCode ?? 0) !== 0,
            ...base,
          };

        case "custom":
          return {
            role: "custom",
            content: typeof msg.content === "string"
              ? msg.content
              : extractTextBlocks(msg.content),
            ...base,
          };

        case "branchSummary":
        case "compactionSummary":
          return {
            role: msg.role,
            content: msg.summary,
            ...base,
          };

        default:
          return {
            role: "unknown",
            content: `[Unknown role: ${(msg as { role: string }).role}]`,
            ...base,
          };
      }
    });
}

// ============================================================================
// 文本提取辅助函数
// ============================================================================

/** 从用户消息提取文本 */
function extractTextFromUser(msg: UserMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return extractTextBlocks(msg.content);
}

/** 从助手消息提取文本（跳过 toolCall 和 thinking） */
function extractTextFromAssistant(msg: AssistantMessage): string {
  return msg.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** 从工具结果消息提取文本 */
function extractTextFromToolResult(msg: ToolResultMessage): string {
  return msg.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** 从内容块数组提取文本 */
function extractTextBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** 从助手消息提取工具调用信息 */
function extractToolCallsFromAssistant(msg: AssistantMessage): ToolCallInfo[] {
  return msg.content
    .filter((block): block is ToolCallBlock => block.type === "toolCall")
    .map((block) => ({
      id: block.id,
      name: block.name,
      argsSummary: truncate(JSON.stringify(block.arguments, null, 0), MAX_ARGS_SUMMARY),
      // ToolResultMessage 会在后续 entry 中出现，这里先留空
      // 实际结果由 mergeToolResults() 补充
      resultSummary: "",
      isError: false,
    }));
}

// ============================================================================
// 工具调用结果合并
// ============================================================================

/**
 * 将 toolResult 消息的结果回填到对应 assistant 消息的 toolCalls 中
 *
 * 使用 toolCallId 精确匹配。遍历所有 toolResult，找到对应的 assistant toolCall 填充结果。
 */
export function mergeToolResults(transcript: TranscriptMessage[]): TranscriptMessage[] {
  const result = transcript.map((msg) => ({
    ...msg,
    toolCalls: msg.toolCalls?.map((tc) => ({ ...tc })),
  }));

  // 建立 toolCallId -> { assistantIndex, callIndex } 的映射
  const callIdMap = new Map<string, { ai: number; ci: number }>();
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role === "assistant" && msg.toolCalls) {
      for (let j = 0; j < msg.toolCalls.length; j++) {
        callIdMap.set(msg.toolCalls[j].id, { ai: i, ci: j });
      }
    }
  }

  // 遍历 toolResult，回填
  for (const msg of result) {
    if (msg.role === "toolResult" && msg.toolCallId) {
      const target = callIdMap.get(msg.toolCallId);
      if (target) {
        const tc = result[target.ai].toolCalls![target.ci];
        tc.resultSummary = truncate(msg.content, MAX_RESULT_SUMMARY);
        tc.isError = msg.isError ?? false;
      }
    }
  }

  return result;
}

// ============================================================================
// SQL 表名提取（用于字典过滤 + 数据来源标注）
// ============================================================================

/**
 * 从整个 session transcript 中提取所有使用过的表名
 *
 * 扫描 assistant 消息的 toolCalls 中 query_data / visualize 的 SQL 参数。
 */
export function extractTableNamesFromSession(transcript: TranscriptMessage[]): string[] {
  const tables = new Set<string>();
  for (const msg of transcript) {
    if (!msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      if (tc.name !== "query_data" && tc.name !== "visualize") continue;
      try {
        const args = JSON.parse(tc.argsSummary);
        const sql = args.sql;
        if (typeof sql === "string") {
          extractTableNames(sql).forEach((t) => tables.add(t));
        }
      } catch {
        // JSON 解析失败（可能已被截断）则跳过
      }
    }
  }
  return Array.from(tables);
}

/**
 * 从单条 SQL 中提取表名（FROM / JOIN 子句）
 *
 * 简单正则实现，可能包含子查询中的表名（通常也是相关表，可接受）。
 */
function extractTableNames(sql: string): string[] {
  // 移除注释和字符串，避免误匹配
  let cleaned = sql.replace(/'[^']*'/g, "''");
  cleaned = cleaned.replace(/--[^\n]*/g, "");
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "");

  const tables: string[] = [];
  const regex = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(cleaned)) !== null) {
    tables.push(m[1]);
  }
  return [...new Set(tables)];
}

// ============================================================================
// 工具函数
// ============================================================================

/** 截断字符串 */
function truncate(str: string, maxLen: number): string {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}