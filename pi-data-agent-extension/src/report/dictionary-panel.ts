/**
 * Task 3 — 数据字典状态面板
 *
 * 从 persistence 读取字典数据，渲染为折叠式表格。
 * v0.5 新增：前端筛选按钮（字段名搜索 + 状态筛选）
 */

import type { DataDictionaryEntry, ColumnSemantic, ColumnSemanticStatus } from "../types.js";

/**
 * 渲染字典面板 HTML
 *
 * @param entries - 数据字典条目列表
 * @returns HTML 字符串（空字符串表示无字典）
 */
export function renderDictionaryPanel(entries: DataDictionaryEntry[]): string {
  if (entries.length === 0) return "";

  const tables = entries.map(renderTable).join("\n");

  return `
<details class="dict-panel">
  <summary class="dict-summary">
    <span class="dict-title">📋 数据字典</span>
    <span class="dict-count">${entries.length} 个数据集</span>
  </summary>
  <div class="dict-content">
    ${tables}
  </div>
  ${DICT_FILTER_SCRIPT}
</details>`;
}

/**
 * 渲染单个表的字典表格（含筛选控件）
 */
function renderTable(entry: DataDictionaryEntry): string {
  const tableId = escapeHtml(entry.tableName);
  const rows = entry.columns.map((col) => renderColumnRow(col)).join("\n");

  return `
<div class="dict-table-wrapper" data-table="${tableId}">
  <h3 class="dict-table-name">${tableId}</h3>
  <div class="dict-filters">
    <input type="text" class="dict-filter-input" placeholder="搜索字段名..." data-table="${tableId}">
    <select class="dict-filter-status" data-table="${tableId}">
      <option value="all">全部状态</option>
      <option value="user-confirmed">已确认</option>
      <option value="user-corrected">已修正</option>
      <option value="ai-guessed">AI推断</option>
      <option value="uncertain">不确定</option>
    </select>
  </div>
  <table class="dict-table">
    <thead>
      <tr>
        <th>字段名</th>
        <th>类型</th>
        <th>状态</th>
        <th>说明</th>
      </tr>
    </thead>
    <tbody data-table="${tableId}">
      ${rows}
    </tbody>
  </table>
</div>`;
}

/**
 * 渲染单列行
 */
function renderColumnRow(col: ColumnSemantic): string {
  const statusClass = getStatusClass(col.status);
  const statusLabel = getStatusLabel(col.status);
  const meaning = col.userMeaning ?? col.inferredMeaning ?? "—";

  return `<tr data-status="${col.status}" data-name="${escapeHtml(col.name)}">
  <td><code class="dict-col-name">${escapeHtml(col.name)}</code></td>
  <td><span class="dict-type">${escapeHtml(col.type)}</span></td>
  <td><span class="dict-badge ${statusClass}">${statusLabel}</span></td>
  <td>${escapeHtml(meaning)}</td>
</tr>`;
}

/**
 * 状态 → CSS class
 */
function getStatusClass(status: ColumnSemanticStatus): string {
  switch (status) {
    case "user-confirmed": return "badge-confirmed";
    case "user-corrected": return "badge-corrected";
    case "uncertain": return "badge-uncertain";
    default: return "badge-guessed";
  }
}

/**
 * 状态 → 中文标签
 */
function getStatusLabel(status: ColumnSemanticStatus): string {
  switch (status) {
    case "user-confirmed": return "已确认";
    case "user-corrected": return "已修正";
    case "uncertain": return "不确定";
    default: return "AI推断";
  }
}

/** HTML 转义 */
function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 字典面板筛选脚本（内联，无外部依赖）
 */
const DICT_FILTER_SCRIPT = `
<script>
(function() {
  function applyFilter(tableName) {
    var input = document.querySelector('.dict-filter-input[data-table="' + tableName + '"]');
    var select = document.querySelector('.dict-filter-status[data-table="' + tableName + '"]');
    var query = (input ? input.value : '').toLowerCase();
    var statusFilter = select ? select.value : 'all';
    var rows = document.querySelectorAll('tbody[data-table="' + tableName + '"] tr');
    rows.forEach(function(row) {
      var name = (row.getAttribute('data-name') || '').toLowerCase();
      var status = row.getAttribute('data-status') || '';
      var matchName = name.indexOf(query) !== -1;
      var matchStatus = statusFilter === 'all' || status === statusFilter;
      row.style.display = matchName && matchStatus ? '' : 'none';
    });
  }

  document.querySelectorAll('.dict-filter-input').forEach(function(input) {
    input.addEventListener('input', function() {
      applyFilter(this.getAttribute('data-table'));
    });
  });

  document.querySelectorAll('.dict-filter-status').forEach(function(select) {
    select.addEventListener('change', function() {
      applyFilter(this.getAttribute('data-table'));
    });
  });
})();
</script>
`;

/**
 * 字典面板 CSS（追加到 html-template.ts 的 STYLES 中）
 */
export const DICTIONARY_CSS = `
/* === 字典面板 === */
.dict-panel {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 20px;
  overflow: hidden;
}

.dict-summary {
  padding: 12px 16px;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  user-select: none;
  list-style: none;
}

.dict-summary::-webkit-details-marker {
  display: none;
}

.dict-summary::before {
  content: "▶";
  margin-right: 8px;
  font-size: 10px;
  transition: transform 0.15s;
  display: inline-block;
}

.dict-panel[open] .dict-summary::before {
  transform: rotate(90deg);
}

.dict-title {
  color: var(--accent);
}

.dict-count {
  font-size: 12px;
  color: var(--fg-muted);
  font-weight: 400;
}

.dict-content {
  padding: 0 16px 16px;
}

.dict-table-wrapper {
  margin-bottom: 16px;
}

.dict-table-wrapper:last-child {
  margin-bottom: 0;
}

.dict-table-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-secondary);
  margin-bottom: 8px;
  margin-top: 12px;
}

/* === 筛选控件 === */
.dict-filters {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  align-items: center;
}

.dict-filter-input {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg);
  font-size: 12px;
  font-family: inherit;
}

.dict-filter-input::placeholder {
  color: var(--fg-muted);
  opacity: 0.6;
}

.dict-filter-status {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.dict-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.dict-table th,
.dict-table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}

.dict-table th {
  font-weight: 600;
  color: var(--fg-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.dict-table td {
  color: var(--fg);
}

.dict-table tr:hover td {
  background: var(--bg-surface);
}

.dict-col-name {
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", monospace;
  font-size: 11px;
  color: var(--accent-secondary);
}

.dict-type {
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", monospace;
  font-size: 11px;
  color: var(--fg-muted);
}

/* 状态标签 */
.dict-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}

.badge-confirmed {
  background: rgba(166, 227, 161, 0.15);
  color: var(--accent);
}

.badge-corrected {
  background: rgba(137, 180, 250, 0.15);
  color: var(--accent-secondary);
}

.badge-uncertain {
  background: rgba(243, 139, 168, 0.15);
  color: var(--red);
}

.badge-guessed {
  background: rgba(249, 226, 175, 0.15);
  color: var(--yellow);
}
`;
