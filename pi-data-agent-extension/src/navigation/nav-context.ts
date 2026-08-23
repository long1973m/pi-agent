/**
 * v0.10 A-4 — L0 导航层注入（渐进式披露：常驻地图 + 按需下钻）
 *
 * 职责：
 * - 渲染 before_agent_start 的 "Data Navigation" 段：每表一行（表名 · 标签 · 一句话 summary），
 *   无卡片退化为 N 行 M 列；整体预算 ≤400 token（字符数近似断言，NAV_CHAR_BUDGET）
 * - 超预算时表格清单折叠为分类标签 + "用 get_table_card 查看详情" 提示
 * - 附"用户的高频/固定分析"（A-5 pinned，≤10 条）与"指标定义"（A-6，≤20 条全量注入）
 *
 * 本模块是纯函数集合，不持有任何状态；数据由 index.ts 从各知识库读取后传入。
 */

/** 导航层总预算（≈400 token，按 4 字符/token 近似） */
export const NAV_CHAR_BUDGET = 1600;

/** 查询记忆注入段预算 */
export const QUERY_MEMORY_CHAR_BUDGET = 1500;

/** 口径（历史 caliber）注入段预算 */
export const CALIBER_CHAR_BUDGET = 1200;

/** pinned 注入条数上限（规范 §11 风险降级） */
export const PINNED_INJECTION_LIMIT = 10;

/** 指标全量注入上限（超过按最近使用截断，规范 §8.1） */
export const METRICS_INJECTION_LIMIT = 20;

/** 导航层表格输入（来自 engine.getTableOverview） */
export interface NavTableInfo {
  name: string;
  rowCount: number;
  columnCount: number;
}

/** 导航层卡片输入（来自 TableCardStore） */
export interface NavCardInfo {
  summary?: string;
  tags?: string[];
  stale?: boolean;
}

/** pinned 注入条目（来自 QueryMemoryManager.getPinnedEntries） */
export interface PinnedQueryInfo {
  naturalLanguageQuery: string;
  sql: string;
}

/** 指标注入条目（非 legacy 的 MetricEntry 投影） */
export interface MetricInjectionInfo {
  name: string;
  definition: string;
  updatedAt?: string;
}

/** 截断到预算内（超限加省略标记） */
export function truncateToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)) + "…";
}

/**
 * 单表导航行：
 * 有卡片 → `- 表名 · 标签1/标签2 · 一句话summary`；无卡片 → `- 表名: N rows, M columns`
 */
export function renderNavLine(table: NavTableInfo, card?: NavCardInfo | null): string {
  if (card && card.summary && card.summary.trim()) {
    const tags = (card.tags ?? []).filter((t) => t && t.trim());
    const parts = [table.name];
    if (tags.length > 0) parts.push(tags.slice(0, 3).join("/"));
    parts.push(card.stale ? `${card.summary.trim()}（结构已变化，卡片待更新）` : card.summary.trim());
    return `- ${parts.join(" · ")}`;
  }
  // 无卡片退化：行列数展示（不报错）
  return `- ${table.name}: ${table.rowCount} rows, ${table.columnCount} columns`;
}

/**
 * 从 SQL 中提取第一个 FROM/JOIN 的表名（pinned 注入展示"问题 + 表名"用；
 * entry 只存全局 fingerprint 不存表名，故从 SQL 反解，失败返回 null）
 */
export function extractTableNameFromSql(sql: string): string | null {
  // 支持 `tbl` / "tbl" / schema.tbl / db.schema.tbl；取最后一段作为表名
  const match = sql.match(/\b(?:from|join)\s+`?"?([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)*)`?"?/i);
  if (!match?.[1]) return null;
  const segments = match[1].split(".");
  return segments[segments.length - 1];
}

/** "用户的高频/固定分析"小节（每条一行：自然语言问题 + 表名），≤limit 条 */
export function renderPinnedSection(pinned: PinnedQueryInfo[], limit: number = PINNED_INJECTION_LIMIT): string {
  if (pinned.length === 0) return "";
  const lines = pinned.slice(0, limit).map((p) => {
    const tableName = extractTableNameFromSql(p.sql) ?? "(未知表)";
    const question = p.naturalLanguageQuery.length > 60 ? p.naturalLanguageQuery.slice(0, 59) + "…" : p.naturalLanguageQuery;
    return `- "${question}" (${tableName})`;
  });
  return `\n\n### 用户的高频/固定分析（用户固定或高频复用的问法，优先沿用其口径）\n${lines.join("\n")}`;
}

/** "指标定义"小节：名称 + 一行计算规则，≤limit 条（超限按 updatedAt 最近优先截断） */
export function renderMetricsSection(
  metrics: MetricInjectionInfo[],
  limit: number = METRICS_INJECTION_LIMIT,
): string {
  if (metrics.length === 0) return "";
  const sorted = [...metrics].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const selected = sorted.slice(0, limit);
  const lines = selected.map((m) => {
    const definition = m.definition.length > 100 ? m.definition.slice(0, 99) + "…" : m.definition;
    return `- ${m.name} = ${definition.replace(/\n+/g, " ")}`;
  });
  const omitted = sorted.length - selected.length;
  return `\n\n### 指标定义（涉及下列指标时，SQL 必须遵守此计算规则）\n${lines.join("\n")}${
    omitted > 0 ? `\n（另有 ${omitted} 条指标未列出，可用 get_table_card 按表查看）` : ""
  }`;
}

/**
 * 渲染完整 L0 导航段。
 *
 * 预算策略（规范 §6.1）：
 * 1. 表清单逐行渲染；超预算 → 折叠为分类标签 + 工具下钻提示
 * 2. 追加 pinned 与指标小节
 * 3. 最终仍超预算则硬截断（保证常驻段有上界）
 *
 * 无表时返回 ""（不注入空段）。
 */
export function renderNavContext(input: {
  tables: NavTableInfo[];
  cards: Map<string, NavCardInfo>;
  pinned?: PinnedQueryInfo[];
  metrics?: MetricInjectionInfo[];
}): string {
  const { tables, cards } = input;
  if (!tables || tables.length === 0) return "";

  const header =
    "\n\n## Data Navigation\n\n" +
    "Loaded datasets (call get_table_card with a table name for purpose/boundaries/field meanings):\n";

  let tableBody: string;
  const lines = tables.map((t) => renderNavLine(t, cards.get(t.name)));
  const fullList = lines.join("\n");

  if (header.length + fullList.length <= NAV_CHAR_BUDGET) {
    tableBody = fullList;
  } else {
    // 超预算：只列分类标签并提示下钻
    const tagCounts = new Map<string, number>();
    let summarized = 0;
    for (const t of tables) {
      summarized++;
      for (const tag of cards.get(t.name)?.tags ?? []) {
        const key = tag.trim();
        if (!key) continue;
        tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1);
      }
    }
    const tagLine = tagCounts.size > 0
      ? [...tagCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([tag]) => tag)
          .join("、")
      : "(无标签)";
    tableBody =
      `共 ${summarized} 张表，超出导航预算，已折叠为分类标签：${tagLine}\n` +
      `请勿猜测表内容——需要任何表的信息时，先调用 get_table_card 工具查看详情。`;
  }

  let result = header + tableBody;
  result += renderPinnedSection(input.pinned ?? []);
  result += renderMetricsSection(input.metrics ?? []);

  // 最终兜底截断：保证常驻导航段 ≤ 预算（pinned/指标各自有条数上限，此处防御极端长文本）
  return truncateToBudget(result, NAV_CHAR_BUDGET);
}
