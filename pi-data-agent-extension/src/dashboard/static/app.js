/**
 * Pi Data Agent Dashboard — 前端完整应用
 *
 * 模块结构（v0.10.1：3 Tab — 数据工作台 / 报告 / SQL 历史）：
 * 1. Core: API 客户端、工具函数、编辑守卫（EditGuard，未保存更改保护）
 * 2. Tab 导航（localStorage last-tab-v3，旧 v2/v1 key 丢弃）
 * 3. 报告中心模块（过程记录降级为底部折叠分组）
 * 4. 数据工作台（原"数据"+"语义"合并）：
 *    - 上传模块（模态弹窗，[＋] 按钮打开；413/错误人话映射）
 *    - 数据预览模块（下半区前 50 行预览 + 体检卡 + 表卡片摘要行）
 *    - 表卡片模块（查看/编辑两态）
 *    - 数据字典模块（字段条目查看/编辑两态）
 *    - 指标定义模块（卡片查看/编辑两态）
 * 5. SQL 历史模块
 *
 * v0.10.1 变更：
 * - 上传 bug 三处修复（后端 70mb 专用解析器 + 前端 413/令牌错误映射理顺）
 * - 数据 + 语义 → 一个工作台 Tab；上传改弹窗
 * - AI 推断/AI 起草前端入口撤除（后端 draft API 保留，get_table_card 骨架卡兜底不变）
 * - 表卡片/指标定义/字段字典统一查看/编辑两态
 */

(function () {
  "use strict";

  // ========================================================================
  // Core: Config & API Client
  // ========================================================================

  const API_BASE = "/api";
  let writeToken = "";

  /** 解析 fetch 响应为 JSON（失败时返回空对象，与原 api.fetch 行为一致） */
  async function parseJson(res) {
    try {
      return await res.json();
    } catch {
      return {};
    }
  }

  /**
   * 把非 2xx 响应转成 Error（携带 code/status）。
   * v0.10.1 错误映射理顺：
   * - 只有响应 code 确为 INVALID_WRITE_TOKEN 且刷新令牌重试后仍失效时，才用令牌恢复文案
   * - 413（body 超限）→ 人话文案"文件超过大小限制（最大 50MB）"
   * - 其余错误一律如实展示服务端 message 或状态码
   */
  function toApiError(data, res, tokenStillInvalid) {
    let message;
    if (tokenStillInvalid) {
      message = "操作失败，已尝试自动恢复令牌。请刷新页面重试；若仍失败，在终端重新执行 /dashboard";
    } else if (res.status === 413) {
      message = "文件超过大小限制（最大 50MB）";
    } else {
      message = data.error?.message || `请求失败 (${res.status})`;
    }
    const err = new Error(message);
    err.code = data.error?.code;
    err.status = res.status;
    return err;
  }

  /**
   * 写请求自愈重试：服务端令牌与本地不一致（如 pi 重启后令牌文件被重建）时，
   * 重新拉取 /api/config 刷新 writeToken 并重试一次原请求。
   * 只重试一次，防止无限循环；仍失败则抛出带恢复指引的错误。
   */
  async function retryWithFreshToken(path, options) {
    try {
      const cfgRes = await fetch(`${API_BASE}/config`);
      const cfg = await parseJson(cfgRes);
      if (cfg?.data?.writeToken) {
        writeToken = cfg.data.writeToken;
      }
    } catch { /* 刷新失败则用现有令牌重试，按原错误路径抛出 */ }

    const headers = { "Content-Type": "application/json", ...(options.headers || {}), "X-Write-Token": writeToken };
    const res = await fetch(`${API_BASE}${path}`, { ...options, method: options.method || "GET", headers });
    const data = await parseJson(res);
    if (!res.ok) {
      throw toApiError(data, res, data.error?.code === "INVALID_WRITE_TOKEN");
    }
    return data;
  }

  const api = {
    async fetch(path, options = {}) {
      const url = `${API_BASE}${path}`;
      const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
      const method = (options.method || "GET").toUpperCase();
      const writeMethods = ["POST", "PATCH", "DELETE", "PUT"];
      const isWrite = writeMethods.includes(method);
      if (isWrite && writeToken) {
        headers["X-Write-Token"] = writeToken;
      }
      const res = await fetch(url, { ...options, method: options.method || "GET", headers });
      const data = await parseJson(res);
      if (!res.ok) {
        // 自愈：写请求因令牌失效被拒时，刷新令牌并重试一次
        if (isWrite && data.error?.code === "INVALID_WRITE_TOKEN") {
          return retryWithFreshToken(path, options);
        }
        throw toApiError(data, res, false);
      }
      return data;
    },
  };

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatDate(iso) {
    if (!iso) return "-";
    try {
      return new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch { return iso; }
  }

  function showLoading(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const isReportList = containerId === "analysis-list" || containerId === "session-list";
    const isTable = containerId === "dataset-preview" || containerId === "dataset-stats";
    if (isReportList) {
      el.innerHTML = `<div class="skeleton">${[1,2,3].map(() => '<div class="skeleton-card"><div class="skeleton-line title"></div><div class="skeleton-line long"></div><div class="skeleton-line medium"></div></div>').join("")}</div>`;
    } else if (isTable) {
      el.innerHTML = `<div class="skeleton">${[1,2,3,4,5].map(() => '<div class="skeleton-row"><div class="skeleton-line short"></div><div class="skeleton-line long"></div><div class="skeleton-line medium"></div></div>').join("")}</div>`;
    } else {
      el.innerHTML = `<div class="skeleton">${[1,2,3,4].map(() => '<div class="skeleton-card"><div class="skeleton-line title"></div><div class="skeleton-line long"></div><div class="skeleton-line medium"></div><div class="skeleton-line short"></div></div>').join("")}</div>`;
    }
  }

  function showError(containerId, msg) {
    const el = document.getElementById(containerId);
    if (el) el.innerHTML = `<p class="empty-state">${escapeHtml(msg)}</p>`;
  }

  // ========================================================================
  // v0.11 P2: 富空态（内联 SVG 图标 + 一句话 + 可选行动按钮）
  // 图标为 Lucide 风格线性 SVG（24px / stroke=currentColor，颜色由 CSS --text-low 控制）
  // ========================================================================

  const EMPTY_STATE_ICONS = {
    database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>',
    "file-text": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>',
  };

  /** 富空态：文案沿用既有提示语；actionHtml 为可选行动按钮（无则省略） */
  function buildEmptyStateHtml(iconKey, messageHtml, actionHtml = "") {
    return `
      <div class="empty-state-rich">
        <span class="empty-state-icon">${EMPTY_STATE_ICONS[iconKey] || ""}</span>
        <p class="empty-state-text">${messageHtml}</p>
        ${actionHtml}
      </div>
    `;
  }

  // ========================================================================
  // Toast 通知系统
  // ========================================================================

  const TOAST_ICONS = {
    success: "✓",
    error: "✕",
    warning: "⚠",
    info: "ℹ",
  };

  function showToast(message, type = "info", duration = 3500) {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
      <div class="toast-body">${escapeHtml(message)}</div>
      <button class="toast-close">×</button>
    `;
    const close = () => {
      toast.classList.add("fade-out");
      setTimeout(() => toast.remove(), 200);
    };
    toast.querySelector(".toast-close").addEventListener("click", close);
    container.appendChild(toast);
    if (duration > 0) setTimeout(close, duration);
  }

  function showConfirm(message, options = {}) {
    return new Promise((resolve) => {
      const { title = "确认操作", confirmText = "确认", cancelText = "取消", detail = "" } = options;
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML = `
        <div class="modal-dialog">
          <div class="modal-header"><h3>${escapeHtml(title)}</h3></div>
          <div class="modal-body">${escapeHtml(message)}${detail ? `<pre>${escapeHtml(detail)}</pre>` : ""}</div>
          <div class="modal-footer">
            <button class="btn btn-sm" data-action="cancel">${escapeHtml(cancelText)}</button>
            <button class="btn btn-sm btn-primary" data-action="confirm">${escapeHtml(confirmText)}</button>
          </div>
        </div>
      `;
      overlay.addEventListener("click", (e) => {
        const action = e.target.dataset.action;
        if (action === "confirm") { overlay.remove(); resolve(true); }
        else if (action === "cancel" || e.target === overlay) { overlay.remove(); resolve(false); }
      });
      document.addEventListener("keydown", function escHandler(e) {
        if (e.key === "Escape") { overlay.remove(); resolve(false); document.removeEventListener("keydown", escHandler); }
      });
      document.body.appendChild(overlay);
    });
  }

  function showPrompt(message, defaultValue = "") {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML = `
        <div class="modal-dialog">
          <div class="modal-header"><h3>输入</h3></div>
          <div class="modal-body">${escapeHtml(message)}<input class="modal-input" type="text" value="${escapeHtml(defaultValue)}" /></div>
          <div class="modal-footer">
            <button class="btn btn-sm" data-action="cancel">取消</button>
            <button class="btn btn-sm btn-primary" data-action="confirm">确认</button>
          </div>
        </div>
      `;
      const input = overlay.querySelector(".modal-input");
      input.focus();
      input.select();
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { const v = input.value.trim(); overlay.remove(); resolve(v); }
      });
      overlay.addEventListener("click", (e) => {
        const action = e.target.dataset.action;
        if (action === "confirm") { const v = input.value.trim(); overlay.remove(); resolve(v); }
        else if (action === "cancel" || e.target === overlay) { overlay.remove(); resolve(null); }
      });
      document.addEventListener("keydown", function escHandler(e) {
        if (e.key === "Escape") { overlay.remove(); resolve(null); document.removeEventListener("keydown", escHandler); }
      });
      document.body.appendChild(overlay);
    });
  }

  function copyToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => showToast("已复制到剪贴板", "success", 2000));
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); showToast("已复制到剪贴板", "success", 2000); } catch { showToast("复制失败", "error", 2000); }
      ta.remove();
    }
  }

  // ========================================================================
  // 编辑守卫（v0.10.1：查看/编辑两态的未保存更改保护）
  // 切表 / 关闭上传弹窗前调用 confirmDiscard()，有未保存更改时先 confirm
  // ========================================================================

  const EditGuard = {
    dirtyKeys: new Set(),

    mark(key) { this.dirtyKeys.add(key); },
    unmark(key) { this.dirtyKeys.delete(key); },
    has(key) { return this.dirtyKeys.has(key); },
    isDirty() { return this.dirtyKeys.size > 0; },
    clearAll() { this.dirtyKeys.clear(); },

    /** 有未保存更改时弹确认框。返回 true = 继续离开（丢弃更改），false = 留下 */
    async confirmDiscard(message) {
      if (!this.isDirty()) return true;
      const msg = message || "当前有未保存的修改，离开将丢失这些更改。确定继续？";
      const ok = await showConfirm(msg, { title: "未保存的修改", confirmText: "放弃修改", cancelText: "留在编辑" });
      if (ok) this.clearAll();
      return ok;
    },
  };

  const STATUS_LABELS = {
    "ai-guessed": "AI 推断",
    "user-confirmed": "已确认",
    "user-corrected": "已修正",
    uncertain: "不确定",
  };

  // ========================================================================
  // Tab Navigation（v0.10.1：3 Tab — 数据工作台 / 报告 / SQL 历史）
  // ========================================================================

  const navItems = document.querySelectorAll(".nav-item");
  const panels = document.querySelectorAll(".tab-panel");
  const tabInitialized = {};

  // v0.10.1: last-tab key 升级为 v3；旧 v1/v2 key 读到即丢弃（不迁移不报错）
  const LAST_TAB_KEY = "dashboard-last-tab-v3";
  const LEGACY_LAST_TAB_KEYS = ["dashboard-last-tab", "dashboard-last-tab-v2"];
  const VALID_TABS = ["data", "reports", "sql-history"];

  // 注意：不在这里恢复上次 tab，因为此时模块还未定义，会触发 ReferenceError
  // 改为在 init() 完成后延迟恢复

  navItems.forEach((item) => {
    item.addEventListener("click", () => switchTab(item.dataset.tab));
  });

  function switchTab(tabId) {
    navItems.forEach((n) => n.classList.toggle("active", n.dataset.tab === tabId));
    panels.forEach((p) => p.classList.toggle("active", p.id === `tab-${tabId}`));
    if (VALID_TABS.includes(tabId)) {
      localStorage.setItem(LAST_TAB_KEY, tabId);
    }

    // 懒加载
    if (!tabInitialized[tabId]) {
      tabInitialized[tabId] = true;
      switch (tabId) {
        case "data": loadWorkbench(); break;
        case "reports": ReportsModule.load(); break;
        case "sql-history": SqlHistoryModule.load(); break;
      }
    }
  }

  /**
   * v0.10.2: 数据工作台统一表选择——DatasetsModule 的全局选择器是唯一入口，
   * 表卡片/字段字典/体检卡/预览全部跟随它。首次加载时先确定全局表，
   * 再让各分区以该表为目标初始化。
   */
  async function loadWorkbench() {
    await DatasetsModule.load();
    const target = DatasetsModule.currentTableName;
    TableCardsModule.load(target);
    DictionariesModule.load(target);
    MetricsModule.load();
  }

  // ========================================================================
  // Module: 报告中心
  // ========================================================================

  const ReportsModule = {
    currentQuery: "",

    async load() {
      const analysisList = document.getElementById("analysis-list");
      const sessionList = document.getElementById("session-list");
      if (analysisList) analysisList.innerHTML = '<div class="loading">加载中...</div>';
      if (sessionList) sessionList.innerHTML = '<div class="loading">加载中...</div>';

      // 同步搜索框值（骨架保留在 DOM 中）
      const searchInput = document.getElementById("report-search");
      if (searchInput) searchInput.value = this.currentQuery;

      try {
        const queryStr = this.currentQuery ? `&query=${encodeURIComponent(this.currentQuery)}` : "";
        const res = await api.fetch(`/reports?page=1&size=100${queryStr}`);
        const { items } = res.data;

        // 按类型分组
        const analysisItems = items.filter(r => r.type === "analysis");
        const sessionItems = items.filter(r => r.type !== "analysis");

        // 更新计数
        const analysisCount = document.getElementById("analysis-count");
        const sessionCount = document.getElementById("session-count");
        if (analysisCount) analysisCount.textContent = analysisItems.length;
        if (sessionCount) sessionCount.textContent = sessionItems.length;

        // 填充左侧：正式分析报告
        if (analysisItems.length === 0) {
          // v0.11 P2: 富空态（沿用原提示文案，无应用内行动入口故不带按钮）
          analysisList.innerHTML = buildEmptyStateHtml("file-text", "暂无正式分析报告。在终端完成分析后执行 /report 生成");
        } else {
          analysisList.innerHTML = analysisItems.map((r) => {
            const modeTag = r.reportMode
              ? `<span class="tag" style="background:var(--brand-subtle);color:var(--accent2)">${escapeHtml(r.reportMode)}</span>`
              : "";
            const coverageBar = r.evidenceCoverage !== undefined
              ? `<div style="margin-top:6px"><div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted)"><span>证据覆盖率</span><span>${(r.evidenceCoverage * 100).toFixed(0)}%</span></div><div style="height:4px;background:var(--surface2);border-radius:2px;margin-top:2px"><div style="height:100%;width:${r.evidenceCoverage * 100}%;background:${r.evidenceCoverage >= 1 ? 'var(--accent)' : 'var(--warning)'};border-radius:2px"></div></div></div>`
              : "";
            const chartsHtml = r.charts && r.charts.length > 0 ? `
              <div style="display:flex;gap:6px;margin:8px 0;flex-wrap:wrap">
                ${r.charts.slice(0, 3).map((c, i) => {
                  if (c.thumbnailUrl) {
                    return `
                      <div style="width:80px;height:60px;border-radius:6px;overflow:hidden;background:var(--surface2);flex-shrink:0">
                        <img src="${c.thumbnailUrl}" style="width:100%;height:100%;object-fit:cover" alt="图表${i+1}" />
                      </div>
                    `;
                  }
                  return `
                    <div style="width:80px;height:60px;background:var(--surface2);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px" title="${escapeHtml(c.title || '图表')}">
                      📊 ${escapeHtml(c.title || `图表${i+1}`)}
                    </div>
                  `;
                }).join("")}
                ${r.charts.length > 3 ? `<div style="width:80px;height:60px;background:var(--surface);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--muted);border:1px dashed var(--border);flex-shrink:0">+${r.charts.length - 3}</div>` : ""}
              </div>
            ` : "";

            return `
              <div class="card card-analysis">
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
                  ${modeTag}
                </div>
                <div class="card-title">${escapeHtml(r.title)}</div>
                <div class="card-subtitle">${escapeHtml(r.summary)}</div>
                ${chartsHtml}
                ${coverageBar}
                <div class="card-meta">
                  <span style="font-size:12px;color:var(--muted)">${formatDate(r.createdAt)}</span>
                  ${r.datasets.map((d) => `<span class="tag tag-dataset">${escapeHtml(d)}</span>`).join("")}
                </div>
                <div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                  <button class="btn btn-sm" style="font-size:11px;padding:2px 8px" onclick="event.stopPropagation();ReportsModule.openReport('${escapeHtml(r.id)}')">打开</button>
                  <button class="btn btn-sm" style="font-size:11px;padding:2px 8px" onclick="event.stopPropagation();ReportsModule.printReport('${escapeHtml(r.id)}')">打印</button>
                  ${r.sourceSessionId ? `<button class="btn btn-sm" style="font-size:11px;padding:2px 8px" onclick="event.stopPropagation();ReportsModule.openSessionReport('${escapeHtml(r.sourceSessionId)}')">查看过程</button>` : ""}
                </div>
                ${r.sourceSessionId ? `
                  <div style="margin-top:4px;font-size:11px;color:var(--muted)">
                    来源: <a href="#" onclick="event.preventDefault();event.stopPropagation();ReportsModule.openSessionReport('${escapeHtml(r.sourceSessionId)}')" style="color:var(--accent2)">分析过程记录</a>
                  </div>
                ` : ""}
              </div>
            `;
          }).join("");
        }

        // 填充底部折叠分组：分析过程记录（v0.10 A-1：降级为折叠区，数据不丢）
        if (sessionItems.length === 0) {
          // v0.11 P2: 富空态（沿用原提示文案，无应用内行动入口故不带按钮）
          sessionList.innerHTML = buildEmptyStateHtml("history", "暂无分析过程记录。在 TUI 中执行查询和可视化后，记录将在此显示");
        } else {
          sessionList.innerHTML = sessionItems.map((r) => {
            const chartCountHtml = r.charts && r.charts.length > 0 ? `<span style="font-size:11px;color:var(--muted)">${r.charts.length} 张图表</span>` : "";
            return `
              <div class="session-row" style="cursor:pointer" onclick="ReportsModule.openReport('${escapeHtml(r.id)}')">
                <div style="flex:1;min-width:0;overflow:hidden">
                  <div style="font-size:13px;font-weight:500;white-space:nowrap;text-overflow:ellipsis;overflow:hidden">${escapeHtml(r.title)}</div>
                </div>
                <div style="display:flex;align-items:center;gap:12px;flex-shrink:0">
                  <span style="font-size:11px;color:var(--muted)">${formatDate(r.createdAt)}</span>
                  ${r.datasets.map((d) => `<span class="tag tag-dataset" style="font-size:10px">${escapeHtml(d)}</span>`).join("")}
                  ${chartCountHtml}
                </div>
              </div>
            `;
          }).join("");
        }
      } catch (err) {
        const msg = `加载失败: ${err.message}`;
        if (analysisList) analysisList.innerHTML = `<p class="empty-state">${escapeHtml(msg)}</p>`;
        if (sessionList) sessionList.innerHTML = `<p class="empty-state">${escapeHtml(msg)}</p>`;
      }
    },

    search() {
      const input = document.getElementById("report-search");
      this.currentQuery = input ? input.value.trim() : "";
      this.load();
    },

    bindSearchEvents() {
      const searchInput = document.getElementById("report-search");
      if (searchInput) {
        searchInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") ReportsModule.search();
        });
      }
    },
    openReport(reportId) {
      // 使用 CSS class 而非 inline style，支持动画和键盘关闭
      const existing = document.getElementById("report-modal");
      if (existing) existing.remove();
      const modal = document.createElement("div");
      modal.id = "report-modal";
      modal.className = "report-modal";
      modal.innerHTML = `
        <div class="report-modal-inner">
          <div class="report-modal-header">
            <span>报告预览</span>
            <button class="btn btn-sm" id="report-modal-close">关闭</button>
          </div>
          <iframe id="report-iframe" class="report-modal-iframe" sandbox="allow-same-origin" srcdoc=""></iframe>
        </div>`;
      modal.querySelector("#report-modal-close").addEventListener("click", () => modal.remove());
      modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
      const escHandler = (e) => { if (e.key === "Escape") { modal.remove(); document.removeEventListener("keydown", escHandler); } };
      document.addEventListener("keydown", escHandler);
      document.body.appendChild(modal);

      // 加载报告内容
      api.fetch(`/reports/${reportId}/content`).then((res) => {
        const iframe = document.getElementById("report-iframe");
        if (iframe) iframe.srcdoc = res.data.content;
      }).catch((err) => {
        modal.innerHTML = `<p style="color:var(--danger);padding:20px">加载失败: ${escapeHtml(err.message)}</p>`;
      });
    },

    printReport(reportId) {
      // 在新窗口打开报告并触发打印
      api.fetch(`/reports/${reportId}/content`).then((res) => {
        const printWindow = window.open("", "_blank");
        if (printWindow) {
          printWindow.document.write(res.data.content);
          printWindow.document.close();
          setTimeout(() => printWindow.print(), 500);
        }
      }).catch((err) => showToast(`加载失败: ${err.message}`, "error"));
    },

    openSessionReport(sessionId) {
      // 打开 session report（如果存在）
      // sessionId 可能是 sourceSessionId，对应的 report id 可能不同
      // 简化实现：调用 API 获取该 session 的报告列表
      api.fetch(`/reports?query=${encodeURIComponent(sessionId)}`).then((res) => {
        const items = res.data.items;
        if (items.length > 0) {
          this.openReport(items[0].id);
        } else {
          showToast("未找到对应的分析过程记录", "warning");
        }
      }).catch((err) => showToast(`查找失败: ${err.message}`, "error"));
    },

    /**
     * v0.10 A-1: 展开/收起底部"分析过程记录"折叠分组。
     * 生成正式报告的入口在 Dashboard 已移除（原为固定 501 的死端按钮），
     * 提示文案见 index.html 折叠组头部：在终端完成分析后执行 /report 生成。
     */
    toggleSessionRecords() {
      const list = document.getElementById("session-list");
      const arrow = document.getElementById("session-records-arrow");
      if (!list) return;
      const expanded = list.style.display !== "none";
      list.style.display = expanded ? "none" : "";
      if (arrow) {
        arrow.classList.toggle("expanded", !expanded);
        arrow.textContent = expanded ? "▸" : "▾";
      }
    },
  };

  // ========================================================================
  // Module: 上传弹窗（v0.10.1：上传改为模态弹窗，由数据 Tab 右上角 [＋] 打开）
  //   - 拖拽/选文件 + 支持格式与 50MB 上限说明
  //   - 成功：关弹窗 → 定位新表 → 下半区预览 + 体检卡 + 建议问句
  //   - 失败：弹窗内展示人话错误（413 已在 toApiError 映射）
  // ========================================================================

  const UPLOAD_ALLOWED_EXTENSIONS = [".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".parquet", ".pq", ".xlsx", ".xls"];
  const UPLOAD_MAX_SIZE = 50 * 1024 * 1024;

  const UploadModule = {
    dragCounter: 0,
    uploading: false,

    openModal() {
      if (document.getElementById("upload-modal-overlay")) return;
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.id = "upload-modal-overlay";
      overlay.innerHTML = `
        <div class="modal-dialog upload-modal-dialog">
          <div class="modal-header">
            <h3>上传数据</h3>
            <button class="upload-modal-close" data-action="close" title="关闭">×</button>
          </div>
          <div class="modal-body">
            <div class="upload-area" id="upload-dropzone">
              <div class="upload-icon">📁</div>
              <div class="upload-text">拖拽文件到此处，或</div>
              <button class="btn btn-primary" id="upload-select-btn">选择文件</button>
              <input type="file" id="upload-input" accept="${UPLOAD_ALLOWED_EXTENSIONS.join(",")}" style="display:none" />
              <div class="upload-hint">支持 CSV / TSV / JSON / JSONL / Parquet / Excel，单文件最大 50MB<br />上传后自动建表并定位到下方预览</div>
            </div>
            <div id="upload-status"></div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const dropzone = overlay.querySelector("#upload-dropzone");
      const input = overlay.querySelector("#upload-input");
      overlay.querySelector("#upload-select-btn").addEventListener("click", () => input.click());
      input.addEventListener("change", (e) => {
        const file = e.target.files?.[0];
        if (file) this.uploadFile(file);
        input.value = "";
      });

      ["dragenter", "dragover"].forEach((evt) => {
        dropzone.addEventListener(evt, (e) => {
          e.preventDefault();
          this.dragCounter++;
          dropzone.classList.add("drag-over");
        });
      });
      dropzone.addEventListener("dragleave", (e) => {
        e.preventDefault();
        this.dragCounter--;
        if (this.dragCounter <= 0) {
          dropzone.classList.remove("drag-over");
          this.dragCounter = 0;
        }
      });
      dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        this.dragCounter = 0;
        dropzone.classList.remove("drag-over");
        const file = e.dataTransfer?.files?.[0];
        if (file) this.uploadFile(file);
      });

      // 关闭途径：× 按钮 / 点击遮罩 / Esc——统一走 requestClose（未保存更改先 confirm）
      overlay.addEventListener("click", (e) => {
        const action = e.target.dataset?.action;
        if (action === "close") { this.requestClose(); return; }
        if (e.target === overlay) this.requestClose();
      });
      this._escHandler = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); this.requestClose(); }
      };
      document.addEventListener("keydown", this._escHandler, true);
    },

    /** 关闭请求：上传中不可关；有未保存修改时先 confirm */
    async requestClose() {
      if (this.uploading) {
        showToast("正在上传，请稍候…", "warning");
        return;
      }
      const ok = await EditGuard.confirmDiscard("当前有未保存的修改尚未保存。确定关闭上传窗口？");
      if (!ok) return;
      this.closeModal(true);
    },

    closeModal(force) {
      if (!force && this.uploading) {
        showToast("正在上传，请稍候…", "warning");
        return;
      }
      const overlay = document.getElementById("upload-modal-overlay");
      if (overlay) overlay.remove();
      if (this._escHandler) {
        document.removeEventListener("keydown", this._escHandler, true);
        this._escHandler = null;
      }
      this.setStatus("");
    },

    /** 弹窗内状态区（成功提示/人话错误），不依赖 toast */
    setStatus(type, msg) {
      const el = document.getElementById("upload-status");
      if (!el) return;
      el.innerHTML = msg ? `<div class="upload-error-box ${type}">${escapeHtml(msg)}</div>` : "";
    },

    async uploadFile(file) {
      if (this.uploading) return;
      if (file.size > UPLOAD_MAX_SIZE) {
        this.setStatus("error", `文件过大 (${(file.size / (1024 * 1024)).toFixed(1)}MB)，最大支持 50MB`);
        return;
      }

      const ext = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
      if (!UPLOAD_ALLOWED_EXTENSIONS.includes(ext)) {
        this.setStatus("error", `不支持的文件格式: ${ext}。支持 ${UPLOAD_ALLOWED_EXTENSIONS.join(" / ")}`);
        return;
      }

      this.uploading = true;
      this.setStatus("info", `正在上传并加载 ${escapeHtml(file.name)}（${(file.size / (1024 * 1024)).toFixed(1)}MB）…`);

      try {
        const base64 = await this.fileToBase64(file);
        const res = await api.fetch("/upload", {
          method: "POST",
          body: JSON.stringify({
            filename: file.name,
            content: base64,
            format: ext.slice(1),
          }),
        });

        if (res.data) {
          const loaded = res.data.loaded;
          if (loaded && loaded.ok) {
            // v0.10.1: 成功 → 关弹窗 → 定位新表 → 下半区预览 + 体检卡 + 建议问句
            this.closeModal(true);
            Dashboard.showToast(`已加载为表 \`${loaded.tableName}\`（${loaded.rowCount} 行 ${loaded.columnCount} 列）`, "success", 5000);
            await Dashboard.showUploadedTable(loaded);
          } else if (loaded && !loaded.ok) {
            this.setStatus("warning", `上传成功，但自动建表未完成：${loaded.reason}`);
          } else {
            this.closeModal(true);
            Dashboard.showToast(`上传成功: ${res.data.originalName} (${res.data.sizeFormatted})`, "success");
          }
        } else {
          this.setStatus("error", "上传响应为空，请重试");
        }
      } catch (err) {
        // err.message 已经是 toApiError 映射后的人话（如 413 → 文件超过大小限制）
        this.setStatus("error", `上传失败：${err.message}`);
      } finally {
        this.uploading = false;
      }
    },

    fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result);
          const commaIdx = result.indexOf(",");
          resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
        };
        reader.onerror = () => reject(new Error("文件读取失败"));
        reader.readAsDataURL(file);
      });
    },
  };

  // ========================================================================
  // Module: 数据字典
  // ========================================================================

  const DictionariesModule = {
    currentTable: null,
    currentRevision: -1,
    currentStatusFilter: "", // "", "pending", "high", "low", "uncertain", "user-corrected"
    lastEntry: null, // 缓存用于前端筛选
    /** v0.10.1: 当前处于编辑态的字段（null = 全部查看态） */
    editingCol: null,

    /**
     * v0.10.2: 加载字段字典分区（不再有自己的表下拉——跟随全局选中表）。
     * @param targetTable 全局选中的表；为空时回退到字典列表第一个
     */
    async load(targetTable) {
      showLoading("dictionaries-content");
      try {
        const res = await api.fetch("/dictionaries");
        const { tables, revision } = res.data;
        this.currentRevision = revision;

        if (tables.length === 0) {
          document.getElementById("dictionaries-content").innerHTML = '<p class="empty-state">暂无数据字典。请先在 TUI 中加载数据集。</p>';
          return;
        }

        const html = `
          <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
            <button class="btn btn-sm" onclick="DictionariesModule.batchConfirmHighConfidence()">确认高置信度</button>
            <button class="btn btn-sm" onclick="DictionariesModule.exportMarkdown()">导出 Markdown</button>
            <span id="dict-save-status" class="save-status"></span>
          </div>
          <div id="dict-table-content"></div>
        `;

        document.getElementById("dictionaries-content").innerHTML = html;

        // 目标表：全局选中表优先；不在字典列表中时仍尝试加载（后端会返回可用错误）
        const tableName = (targetTable && tables.some((t) => t.name === targetTable))
          ? targetTable
          : (targetTable || tables[0].name);
        await this.loadTable(tableName);
      } catch (err) {
        showError("dictionaries-content", `加载失败: ${err.message}`);
      }
    },

    /** v0.10.2: 全局切表联动入口（EditGuard 检查由选择器统一处理） */
    async setTable(tableName) {
      this.editingCol = null;
      EditGuard.unmark("dict");
      await this.loadTable(tableName);
    },

    async loadTable(tableName) {
      this.currentTable = tableName;
      showLoading("dict-table-content");
      try {
        const res = await api.fetch(`/dictionaries/${encodeURIComponent(tableName)}`);
        const { entry, revision } = res.data;
        this.currentRevision = revision;
        this.lastEntry = entry; // 缓存用于前端筛选
        this.renderTable();
      } catch (err) {
        showError("dict-table-content", `加载表失败: ${err.message}`);
      }
    },

    /**
     * v0.10.1: 从缓存的 lastEntry 渲染字段字典表格。
     * editingCol 为 null 时全部行是查看态（只读文本 + [修改]）；
     * 编辑态行显示输入框 + [保存] [取消]。
     */
    renderTable() {
      const entry = this.lastEntry;
      const tableName = this.currentTable;
      const container = document.getElementById("dict-table-content");
      if (!container) return;

      if (!entry || entry.columns.length === 0) {
        container.innerHTML = `<p class="empty-state">表 "${escapeHtml(tableName)}" 无字段信息</p>`;
        return;
      }

      const statusTagClass = { "ai-guessed": "status-ai-guessed", "user-confirmed": "status-user-confirmed", "user-corrected": "status-user-corrected", uncertain: "status-uncertain" };
      const isEditing = (colName) => this.editingCol === colName;

      const html = `
          <div class="filter-tabs" style="display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap">
            <button class="filter-tab ${!this.currentStatusFilter ? 'active' : ''}" onclick="DictionariesModule.filterStatus('')">全部</button>
            <button class="filter-tab ${this.currentStatusFilter === 'pending' ? 'active' : ''}" onclick="DictionariesModule.filterStatus('pending')">待确认</button>
            <button class="filter-tab ${this.currentStatusFilter === 'high' ? 'active' : ''}" onclick="DictionariesModule.filterStatus('high')">高置信度</button>
            <button class="filter-tab ${this.currentStatusFilter === 'low' ? 'active' : ''}" onclick="DictionariesModule.filterStatus('low')">低置信度</button>
            <button class="filter-tab ${this.currentStatusFilter === 'uncertain' ? 'active' : ''}" onclick="DictionariesModule.filterStatus('uncertain')">不确定</button>
            <button class="filter-tab ${this.currentStatusFilter === 'user-corrected' ? 'active' : ''}" onclick="DictionariesModule.filterStatus('user-corrected')">用户已修正</button>
          </div>
          <div class="table-container">
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:30px"><input type="checkbox" id="dict-select-all" /></th>
                  <th>字段名</th>
                  <th style="width:80px">类型</th>
                  <th style="width:92px">状态</th>
                  <th>业务含义</th>
                  <th style="width:160px">备注</th>
                  <th style="width:100px">AI 建议</th>
                  <th style="width:120px"></th>
                </tr>
              </thead>
              <tbody>
                ${entry.columns.map((col) => {
                  const hasSuggestion = col.suggestion && Object.keys(col.suggestion).length > 0;
                  const confLevel = col.suggestion?.confidenceLevel || "";
                  const confLabel = confLevel === "high" ? "高" : confLevel === "medium" ? "中" : confLevel === "low" ? "低" : "";
                  const confClass = confLevel === "high" ? "confidence-high" : confLevel === "medium" ? "confidence-medium" : confLevel === "low" ? "confidence-low" : "";
                  const editing = isEditing(col.name);
                  const meaningText = col.userMeaning || col.inferredMeaning || "-";
                  const notesText = col.notes || "-";

                  return `
                  <tr data-column="${escapeHtml(col.name)}">
                    <td><input type="checkbox" class="dict-col-check" value="${escapeHtml(col.name)}" ${col.status === "uncertain" ? "" : "checked"} /></td>
                    <td style="font-family:var(--font-mono);font-size:12px;color:var(--accent2)">${escapeHtml(col.name)}</td>
                    <td style="font-size:11px;color:var(--muted)">${escapeHtml(col.type)}</td>
                    <td>
                      ${editing
                        ? `<select class="select dict-status-select" data-col="${escapeHtml(col.name)}" style="font-size:11px;padding:2px 4px">
                            ${Object.entries(STATUS_LABELS).map(([k, v]) =>
                              `<option value="${k}" ${col.status === k ? "selected" : ""}>${v}</option>`
                            ).join("")}
                          </select>`
                        : `<span class="tag ${statusTagClass[col.status] || ""}" title="状态：${STATUS_LABELS[col.status] || col.status}">${STATUS_LABELS[col.status] || col.status}</span>`}
                    </td>
                    <td>
                      ${editing
                        ? `<input class="inline-edit dict-edit-meaning" data-col="${escapeHtml(col.name)}" value="${escapeHtml(col.userMeaning ?? col.inferredMeaning ?? "")}" placeholder="业务含义（留空清除）" style="width:100%" />`
                        : `<span class="ve-value ${meaningText === "-" ? "ve-placeholder" : ""}">${escapeHtml(meaningText)}</span>`}
                    </td>
                    <td>
                      ${editing
                        ? `<input class="inline-edit dict-edit-notes" data-col="${escapeHtml(col.name)}" value="${escapeHtml(col.notes || "")}" placeholder="备注" style="width:100%" />`
                        : `<span class="ve-value ${notesText === "-" ? "ve-placeholder" : ""}">${escapeHtml(notesText)}</span>`}
                    </td>
                    <td>
                      ${hasSuggestion ? `
                        <div style="display:flex;flex-direction:column;gap:2px">
                          <div style="display:flex;gap:4px;align-items:center">
                            ${confLabel ? `<span class="tag ${confClass}">${confLabel}</span>` : ""}
                            <span style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80px" title="${escapeHtml(col.suggestion.meaning || "")}">${escapeHtml(col.suggestion.meaning || "")}</span>
                            <button class="btn btn-sm" style="font-size:10px;padding:1px 4px" onclick="event.stopPropagation();DictionariesModule.toggleEvidence('${escapeHtml(col.name)}')">详情</button>
                          </div>
                          <div id="evidence-detail-${escapeHtml(col.name)}" style="display:none;font-size:10px;color:var(--muted);padding:4px;background:var(--surface2);border-radius:4px;margin-top:2px">
                            ${col.suggestion.evidence && col.suggestion.evidence.length > 0 ? `
                              <div style="margin-bottom:4px">
                                <strong>推断依据:</strong>
                                <ul style="margin:2px 0 0 12px;padding:0">
                                  ${col.suggestion.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}
                                </ul>
                              </div>
                            ` : ""}
                            ${col.suggestion.uncertainties && col.suggestion.uncertainties.length > 0 ? `
                              <div>
                                <strong style="color:var(--warning)">不确定点:</strong>
                                <ul style="margin:2px 0 0 12px;padding:0">
                                  ${col.suggestion.uncertainties.map((u) => `<li>${escapeHtml(u)}</li>`).join("")}
                                </ul>
                              </div>
                            ` : ""}
                          </div>
                        </div>
                      ` : `<span style="font-size:11px;color:var(--muted)">-</span>`}
                    </td>
                    <td>
                      <div style="display:flex;gap:4px;flex-wrap:wrap">
                        ${hasSuggestion ? `
                          <button class="btn btn-sm" style="font-size:11px;padding:1px 6px" onclick="event.stopPropagation();DictionariesModule.reviewColumn('${escapeHtml(col.name)}','confirm')">确认</button>
                          <button class="btn btn-sm" style="font-size:11px;padding:1px 6px" onclick="event.stopPropagation();DictionariesModule.reviewColumn('${escapeHtml(col.name)}','correct')">修正</button>
                          <button class="btn btn-sm" style="font-size:11px;padding:1px 6px" onclick="event.stopPropagation();DictionariesModule.reviewColumn('${escapeHtml(col.name)}','uncertain')">不确定</button>
                        ` : ""}
                        ${editing
                          ? `<button class="btn btn-sm btn-primary" style="font-size:11px;padding:1px 6px" onclick="DictionariesModule.saveColumn('${escapeHtml(col.name)}')">保存</button>
                             <button class="btn btn-sm" style="font-size:11px;padding:1px 6px" onclick="DictionariesModule.cancelRowEdit()">取消</button>`
                          : `<button class="btn btn-sm" style="font-size:11px;padding:1px 6px" onclick="DictionariesModule.startEdit('${escapeHtml(col.name)}')">修改</button>`}
                      </div>
                    </td>
                  </tr>
                `;
                }).join("")}
              </tbody>
            </table>
          </div>
          <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-sm btn-primary" onclick="DictionariesModule.batchConfirm()">确认选中字段</button>
            <span style="font-size:12px;color:var(--muted)">勾选要确认的字段（uncertain 默认不勾选）</span>
          </div>
      `;

      container.innerHTML = html;

      // 绑定编辑态输入 → 标记未保存更改
      container.querySelectorAll(".dict-edit-meaning, .dict-edit-notes, .dict-status-select").forEach((el) => {
        el.addEventListener("input", () => EditGuard.mark("dict"));
        el.addEventListener("change", () => EditGuard.mark("dict"));
      });
    },

    /** v0.10.1: 进入某字段的编辑态（同表其他行回查看态；有未保存修改先确认） */
    async startEdit(colName) {
      if (this.editingCol === colName) return;
      if (this.editingCol && EditGuard.has("dict")) {
        const ok = await EditGuard.confirmDiscard("切换到其他字段将丢失未保存的修改，确定继续？");
        if (!ok) return;
      }
      this.editingCol = colName;
      EditGuard.unmark("dict");
      this.renderTable();
      const input = document.querySelector(`.dict-edit-meaning[data-col="${colName}"]`);
      if (input) { input.focus(); input.select(); }
    },

    /** v0.10.1: 取消编辑，回到查看态（丢弃未保存修改） */
    cancelRowEdit() {
      this.editingCol = null;
      EditGuard.unmark("dict");
      this.renderTable();
    },

    async saveColumn(colName) {
      const row = document.querySelector(`tr[data-column="${colName}"]`);
      if (!row) return;

      const meaningInput = row.querySelector(".dict-edit-meaning");
      const notesInput = row.querySelector(".dict-edit-notes");
      const statusSelect = row.querySelector(".dict-status-select");

      const updates = { expectedRevision: this.currentRevision };
      if (meaningInput) updates.userMeaning = meaningInput.value;
      if (notesInput) updates.notes = notesInput.value;
      if (statusSelect) updates.status = statusSelect.value;

      const status = document.getElementById("dict-save-status");
      status.textContent = "保存中...";
      status.className = "save-status saving";

      try {
        const res = await api.fetch(`/dictionaries/${encodeURIComponent(this.currentTable)}/${encodeURIComponent(colName)}`, {
          method: "PATCH",
          body: JSON.stringify(updates),
        });
        this.currentRevision = res.data.revision;
        status.textContent = "已保存";
        status.className = "save-status saved";
        setTimeout(() => { status.textContent = ""; }, 2000);
        // v0.10.1: 保存成功 → 回查看态并刷新
        this.editingCol = null;
        EditGuard.unmark("dict");
        await this.loadTable(this.currentTable);
      } catch (err) {
        if (err.code === "REVISION_CONFLICT") {
          status.textContent = "版本冲突，请刷新";
          status.className = "save-status conflict";
        } else {
          status.textContent = `保存失败: ${err.message}`;
          status.className = "save-status error";
        }
      }
    },

    async batchConfirm() {
      const checks = document.querySelectorAll(".dict-col-check:checked");
      const columns = Array.from(checks).map((c) => c.value);
      if (columns.length === 0) { showToast("请先勾选要确认的字段", "warning"); return; }
      const ok = await showConfirm(`确认 ${columns.length} 个字段？`, { title: "批量确认" });
      if (!ok) return;

      const status = document.getElementById("dict-save-status");
      status.textContent = "保存中...";
      status.className = "save-status saving";

      try {
        const res = await api.fetch(`/dictionaries/${encodeURIComponent(this.currentTable)}`, {
          method: "PATCH",
          body: JSON.stringify({ operation: "confirm-selected", columns, expectedRevision: this.currentRevision }),
        });
        this.currentRevision = res.data.revision;
        status.textContent = "已保存";
        status.className = "save-status saved";
        setTimeout(() => { status.textContent = ""; }, 2000);
        // v0.10.1: 批量操作后回查看态
        this.editingCol = null;
        EditGuard.unmark("dict");
        await this.loadTable(this.currentTable);
      } catch (err) {
        status.textContent = err.code === "REVISION_CONFLICT" ? "版本冲突" : `失败: ${err.message}`;
        status.className = "save-status error";
      }
    },

    // v0.10.1: AI 推断入口已撤除（runInference 移除）；后端 /infer 路由保留但前端不再触发

    async reviewColumn(colName, action) {
      const body = { action, expectedRevision: this.currentRevision };
      if (action === "correct") {
        const newMeaning = await showPrompt("输入修正后的含义：");
        if (!newMeaning) return;
        body.description = newMeaning;
      }
      try {
        const res = await api.fetch(`/dictionaries/${encodeURIComponent(this.currentTable)}/${encodeURIComponent(colName)}/review`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        this.currentRevision = res.data.revision;
        await this.loadTable(this.currentTable);
      } catch (err) {
        showToast(`审核失败: ${err.message}`, "error");
      }
    },

    async batchConfirmHighConfidence() {
      const ok = await showConfirm("批量确认所有高/中置信度的 AI 推断？", { title: "批量确认" });
      if (!ok) return;
      const status = document.getElementById("dict-save-status");
      status.textContent = "提交中...";
      status.className = "save-status saving";
      try {
        const res = await api.fetch(`/dictionaries/${encodeURIComponent(this.currentTable)}`, {
          method: "PATCH",
          body: JSON.stringify({ operation: "batch-confirm-high-confidence", expectedRevision: this.currentRevision }),
        });
        this.currentRevision = res.data.revision;
        status.textContent = `已确认 ${res.data.confirmed} 个字段`;
        status.className = "save-status saved";
        setTimeout(() => { status.textContent = ""; }, 3000);
        this.editingCol = null;
        EditGuard.unmark("dict");
        await this.loadTable(this.currentTable);
      } catch (err) {
        status.textContent = err.code === "REVISION_CONFLICT" ? "版本冲突" : `失败: ${err.message}`;
        status.className = "save-status error";
      }
    },

    async exportMarkdown() {
      try {
        const res = await fetch(`/api/dictionaries/${encodeURIComponent(this.currentTable)}/export?format=markdown`, { headers: { "Accept": "text/markdown" } });
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${this.currentTable}-dictionary.md`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        showToast(`导出失败: ${err.message}`, "error");
      }
    },

    toggleEvidence(colName) {
      const el = document.getElementById(`evidence-detail-${colName}`);
      if (el) {
        el.style.display = el.style.display === "none" ? "block" : "none";
      }
    },

    filterStatus(status) {
      this.currentStatusFilter = status;
      // 不重新请求 API，只前端过滤
      this.applyStatusFilter();
    },

    applyStatusFilter() {
      const rows = document.querySelectorAll("#dict-table-content tbody tr");
      rows.forEach((row) => {
        if (!this.currentStatusFilter) {
          row.style.display = "";
          return;
        }
        const colName = row.dataset.column;
        // 从缓存的 entry 中查找
        if (!this.lastEntry) { row.style.display = ""; return; }
        const col = this.lastEntry.columns.find((c) => c.name === colName);
        if (!col) { row.style.display = "none"; return; }

        let show = false;
        switch (this.currentStatusFilter) {
          case "pending":
            // 待确认 = 有 suggestion 且 status 为 ai-guessed
            show = col.status === "ai-guessed" && col.suggestion;
            break;
          case "high":
            show = col.suggestion?.confidenceLevel === "high";
            break;
          case "low":
            show = col.suggestion?.confidenceLevel === "low" || col.suggestion?.confidenceLevel === "medium";
            break;
          case "uncertain":
            show = col.status === "uncertain";
            break;
          case "user-corrected":
            show = col.status === "user-corrected" || col.status === "user-confirmed";
            break;
        }
        row.style.display = show ? "" : "none";
      });
    },
  };

  // ========================================================================
  // Module: 表卡片（v0.10 A-3 / v0.10.1 两态化：查看态只读 + [修改]，编辑态输入框 + [保存][取消][确认]）
  //   v0.10.1: AI 起草入口已撤除（后端 draft API 保留）；空卡片文案引导手动填写
  // ========================================================================

  const TABLE_CARD_STATUS_LABELS = {
    "ai-drafted": "AI 起草",
    "user-confirmed": "已确认",
  };

  const TableCardsModule = {
    currentTable: null,
    currentRevision: -1,
    /** v0.10.1: 当前渲染模式（view=查看态 / edit=编辑态），切表时回 view */
    mode: "view",
    /** tableName -> card（与数据 Tab 的摘要行共享 window._tableCardsCache） */
    cardsCache: {},

    /**
     * v0.10.2: 加载表卡片分区（不再有自己的表下拉——跟随全局选中表）。
     * @param targetTable 全局选中的表；为空时回退到"数据集 ∪ 已有卡片"的第一个
     */
    async load(targetTable) {
      showLoading("table-cards-content");
      try {
        const res = await api.fetch("/table-cards");
        const { cards, revision } = res.data;
        this.currentRevision = revision;
        this.cardsCache = {};
        (cards || []).forEach((c) => { this.cardsCache[c.tableName] = c; });
        window._tableCardsCache = this.cardsCache;

        // 表清单 = 已加载数据集 ∪ 已有卡片的表
        let datasetNames = [];
        try {
          const dsRes = await api.fetch("/datasets");
          datasetNames = (dsRes.data || []).map((d) => d.name);
        } catch { /* 引擎不可用时仍可编辑已有卡片 */ }
        const tableNames = [...new Set([...datasetNames, ...Object.keys(this.cardsCache)])];

        if (tableNames.length === 0) {
          // v0.11 P2: 富空态（沿用原提示文案 + 上传行动按钮）
          document.getElementById("table-cards-content").innerHTML = buildEmptyStateHtml(
            "database",
            "暂无数据集。通过右上角「＋ 上传数据」或在 TUI 中加载数据，即可创建表卡片。",
            '<button class="btn btn-sm btn-primary" onclick="Dashboard.openUploadModal()">＋ 上传数据</button>'
          );
          return;
        }

        const html = `
          <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
            <span id="tc-save-status" class="save-status"></span>
          </div>
          <div id="tc-editor"></div>
        `;
        document.getElementById("table-cards-content").innerHTML = html;

        // 目标表：全局选中表优先；不在清单中时也照常渲染（显示"暂无卡片"引导手动填写）
        const tableName = (targetTable && tableNames.includes(targetTable))
          ? targetTable
          : (targetTable || tableNames[0]);
        this.renderEditor(tableName);
      } catch (err) {
        showError("table-cards-content", `加载失败: ${err.message}`);
      }
    },

    /** v0.10.2: 全局切表联动入口（EditGuard 检查由选择器统一处理） */
    setTable(tableName) {
      this.mode = "view";
      EditGuard.unmark("tc");
      this.renderEditor(tableName);
    },

    /** 渲染单表卡片（mode=view 查看态只读 + [修改]；mode=edit 编辑态输入框 + [保存][取消][确认]） */
    renderEditor(tableName) {
      this.currentTable = tableName;
      const card = this.cardsCache[tableName] || null;
      const editorEl = document.getElementById("tc-editor");
      if (!editorEl) return;

      const statusKey = card ? (card.stale ? "stale" : card.status) : "none";
      const badge = statusKey === "none"
        ? '<span class="tag">暂无卡片</span>'
        : statusKey === "stale"
          ? '<span class="tag status-uncertain">已过期</span>'
          : `<span class="tag ${card.status === "user-confirmed" ? "status-user-confirmed" : "status-ai-guessed"}">${TABLE_CARD_STATUS_LABELS[card.status] || card.status}</span>`;

      const headerHtml = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div style="display:flex;gap:8px;align-items:center">
            <span class="card-title" style="margin:0">${escapeHtml(tableName)}</span>
            ${badge}
            ${card ? `<span style="font-size:11px;color:var(--muted)">更新于 ${formatDate(card.updatedAt)}</span>` : ""}
          </div>
          <div style="display:flex;gap:6px">
            ${this.mode === "edit"
              ? `<button class="btn btn-sm" onclick="TableCardsModule.cancelEdit()">取消</button>
                 <button class="btn btn-sm" onclick="TableCardsModule.save(false)">保存</button>
                 <button class="btn btn-sm btn-primary" onclick="TableCardsModule.confirmCard()">确认</button>`
              : `<button class="btn btn-sm btn-primary" onclick="TableCardsModule.startEdit()">修改</button>`}
          </div>
        </div>
      `;

      if (this.mode !== "edit") {
        // ===== 查看态：只读文本 =====
        const listHtml = (label, items) => (items.length > 0
          ? `<div><label style="font-size:12px;color:var(--muted)">${label}</label><div class="ve-value">${items.map((s) => escapeHtml(String(s))).join("<br>")}</div></div>`
          : "");
        const tags = card?.tags || [];
        editorEl.innerHTML = `
        <div class="card">
          ${headerHtml}
          ${statusKey === "none" ? `
            <p class="empty-state" style="text-align:left;margin:8px 0;font-size:12px">暂无表卡片。点击「修改」手动填写：一句话说清这张表是什么、适合什么、不含什么、什么时候来找它——Agent 写 SQL 前会通过 get_table_card 读取。</p>
          ` : ""}
          ${card && card.stale ? '<p class="empty-state" style="text-align:left;margin:8px 0;font-size:12px;color:var(--warning)">表结构已变化，卡片可能过期。点击「修改」核对后重新确认。</p>' : ""}
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">
            <div>
              <label style="font-size:12px;color:var(--muted)">一句话 summary</label>
              <div class="ve-value ${!card?.summary ? "ve-placeholder" : ""}">${card?.summary ? escapeHtml(card.summary) : "（待填写）"}</div>
            </div>
            ${listHtml("适合什么", card?.suitableFor || [])}
            ${listHtml("边界 / 已知坑", card?.boundaries || [])}
            ${listHtml("什么时候需要找它", card?.whenToUse || [])}
            ${tags.length > 0 ? `<div><label style="font-size:12px;color:var(--muted)">分类标签</label><div>${tags.map((t) => `<span class="tag tag-dataset">${escapeHtml(t)}</span>`).join(" ")}</div></div>` : ""}
          </div>
        </div>
      `;
        return;
      }

      // ===== 编辑态：输入框 + [取消][保存][确认] =====
      const val = (v) => Array.isArray(v) ? v.join("\n") : (v || "");
      editorEl.innerHTML = `
        <div class="card">
          ${headerHtml}
          <p class="empty-state" style="text-align:left;margin:8px 0;font-size:12px">一句话说清这张表是什么、适合什么、不含什么、什么时候来找它。Agent 写 SQL 前可通过 get_table_card 读取。</p>
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">
            <div>
              <label style="font-size:12px;color:var(--muted)">一句话 summary *</label>
              <textarea class="inline-edit" id="tc-summary" rows="2" placeholder="例：支付订单明细表，一行一笔已支付订单">${card ? escapeHtml(card.summary || "") : ""}</textarea>
            </div>
            <div>
              <label style="font-size:12px;color:var(--muted)">适合什么（每行一条）</label>
              <textarea class="inline-edit" id="tc-suitable" rows="2" placeholder="例：订单量/GMV 趋势分析">${card ? escapeHtml(val(card.suitableFor)) : ""}</textarea>
            </div>
            <div>
              <label style="font-size:12px;color:var(--muted)">边界 / 已知坑（每行一条）</label>
              <textarea class="inline-edit" id="tc-boundaries" rows="2" placeholder="例：只含 2025 年以后数据；不含已取消订单">${card ? escapeHtml(val(card.boundaries)) : ""}</textarea>
            </div>
            <div>
              <label style="font-size:12px;color:var(--muted)">什么时候需要找它（每行一条）</label>
              <textarea class="inline-edit" id="tc-when" rows="2" placeholder="例：用户问销售额/复购率时">${card ? escapeHtml(val(card.whenToUse)) : ""}</textarea>
            </div>
            <div>
              <label style="font-size:12px;color:var(--muted)">分类标签（逗号分隔，导航分组用）</label>
              <input class="inline-edit" id="tc-tags" value="${card ? escapeHtml((card.tags || []).join(", ")) : ""}" placeholder="例：订单, 交易" />
            </div>
          </div>
        </div>
      `;

      // 编辑态输入 → 标记未保存更改
      ["tc-summary", "tc-suitable", "tc-boundaries", "tc-when", "tc-tags"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("input", () => EditGuard.mark("tc"));
      });
    },

    /** v0.10.1: 进入编辑态 */
    startEdit() {
      this.mode = "edit";
      EditGuard.unmark("tc");
      this.renderEditor(this.currentTable);
    },

    /** v0.10.1: 取消编辑，回查看态 */
    cancelEdit() {
      this.mode = "view";
      EditGuard.unmark("tc");
      this.renderEditor(this.currentTable);
    },

    /** 收集编辑器字段为 PUT body */
    collectFields() {
      const splitLines = (id) => document.getElementById(id).value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return {
        summary: document.getElementById("tc-summary").value.trim(),
        suitableFor: splitLines("tc-suitable"),
        boundaries: splitLines("tc-boundaries"),
        whenToUse: splitLines("tc-when"),
        tags: document.getElementById("tc-tags").value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
      };
    },

    async save(confirm, statusElOverride) {
      if (!this.currentTable) return;
      if (!confirm && !this.collectFields().summary) {
        showToast("summary 不能为空", "warning");
        return;
      }
      const status = statusElOverride || document.getElementById("tc-save-status");
      status.textContent = "保存中...";
      status.className = "save-status saving";
      try {
        const body = this.collectFields();
        if (confirm) body.status = "user-confirmed";
        const res = await api.fetch(`/table-cards/${encodeURIComponent(this.currentTable)}`, {
          method: "PUT",
          body: JSON.stringify({ ...body, expectedRevision: this.currentRevision }),
        });
        this.currentRevision = res.data.revision ?? this.currentRevision;
        if (res.data.card) this.cardsCache[this.currentTable] = res.data.card;
        window._tableCardsCache = this.cardsCache;
        status.textContent = confirm ? "已确认" : "已保存";
        status.className = "save-status saved";
        setTimeout(() => { status.textContent = ""; }, 2000);
        // v0.10.1: 保存/确认成功 → 回查看态
        this.mode = "view";
        EditGuard.unmark("tc");
        this.renderEditor(this.currentTable);
      } catch (err) {
        status.textContent = err.code === "REVISION_CONFLICT" ? "版本冲突，请刷新" : `失败: ${err.message}`;
        status.className = "save-status error";
      }
    },

    async confirmCard() {
      if (!this.collectFields().summary) {
        showToast("请先填写 summary 再确认", "warning");
        return;
      }
      await this.save(true);
    },

    // v0.10.1: AI 起草入口已撤除（draft 方法移除）；
    // 后端 POST /api/table-cards/:table/draft 路由保留，前端不再触发
  };

  /**
   * v0.10 A-3: 数据 Tab 表预览头部的卡片 summary 一行。
   * 优先读 window._tableCardsCache（语义 Tab 刷新过）；缓存缺失时拉一次全量卡片。
   * 无卡片显示占位提示。
   */
  async function renderDatasetCardSummary(tableName) {
    const container = document.getElementById("dataset-card-summary");
    if (!container) return;
    try {
      if (!window._tableCardsCache) {
        const res = await api.fetch("/table-cards");
        window._tableCardsCache = {};
        ((res.data && res.data.cards) || []).forEach((c) => { window._tableCardsCache[c.tableName] = c; });
      }
      const card = window._tableCardsCache[tableName];
      if (card && card.summary) {
        const staleTag = card.stale ? ' <span class="tag status-uncertain">已过期</span>' : "";
        const badge = card.status === "user-confirmed"
          ? '<span class="tag status-user-confirmed">已确认</span>'
          : '<span class="tag status-ai-guessed">AI 起草</span>';
        container.innerHTML = `
          <div class="profile-line" style="margin-bottom:8px">
            <span class="profile-icon">🗂️</span><span class="profile-label">表卡片</span>
            <span>${badge}${staleTag} ${escapeHtml(card.summary)}</span>
          </div>`;
      } else {
        container.innerHTML = `
          <div class="profile-line" style="margin-bottom:8px;color:var(--muted)">
            <span class="profile-icon">🗂️</span><span class="profile-label">表卡片</span>
            <span>暂无表卡片——可在上方「表卡片」区点击「修改」手动填写</span>
          </div>`;
      }
    } catch { /* 卡片摘要失败不影响预览 */ }
  }

  // ========================================================================
  // 数据体检卡（v0.10 A-2：消费上传响应 loaded.dataProfile 结构化字段）
  // ========================================================================

  /**
   * 渲染数据体检卡 HTML。
   * v0.11 P2: 「行×列 / 缺失列 / 时间跨度 / 疑似主键」重排为一行 KPI stat tile
   * （mono 大字号数字 + 小标签，细节信息移入 title 悬浮提示）；
   * 维度线索保留为下方明细行；建议问句渲染为 chip 列表（每条带「复制」按钮，
   * 复制走 copyToClipboard，自带 toast 提示）。profile 缺失时调用方直接不渲染卡片。
   */
  function buildProfileCardHtml(profile) {
    const fmtPct = (v) => `${Number(v).toFixed(1)}%`;

    // 缺失列数 = 需关注 + 严重；无缺失时显示 0
    const missingCount = (profile.missingColumns?.length || 0) + (profile.severeMissingColumns?.length || 0);
    // 悬浮提示保留原有明细（严重 >80% / 需关注 >30%），避免信息丢失
    const missingBits = [];
    if (profile.severeMissingColumns && profile.severeMissingColumns.length > 0) {
      missingBits.push(`严重：${profile.severeMissingColumns.map((c) => `${c.name} ${fmtPct(c.nullPercentage)}`).join("、")}`);
    }
    if (profile.missingColumns && profile.missingColumns.length > 0) {
      missingBits.push(`需关注：${profile.missingColumns.map((c) => `${c.name} ${fmtPct(c.nullPercentage)}`).join("、")}`);
    }
    const missingTitle = missingBits.length > 0 ? ` title="${escapeHtml(missingBits.join("｜"))}"` : "";

    // 时间跨度只取 min~max 的日期部分（YYYY-MM-DD）
    const timeSpan = profile.timeSpan || null;
    const spanValue = timeSpan ? `${toDatePart(timeSpan.min)} ~ ${toDatePart(timeSpan.max)}` : "—";
    const spanLabel = timeSpan ? escapeHtml(timeSpan.column) : "时间跨度";

    // 疑似主键重复：KPI 显示命中列数，明细进悬浮提示
    const pkSuspicion = profile.primaryKeySuspicion || [];
    const pkTitle = pkSuspicion.length > 0
      ? ` title="${escapeHtml(pkSuspicion.map((p) => `${p.column}（${p.duplicateCount} 个重复值）`).join("、"))}"`
      : "";

    const kpiRowHtml = `
      <div class="kpi-row">
        <div class="kpi-tile">
          <span class="kpi-value">${Number(profile.rowCount || 0).toLocaleString()}</span>
          <span class="kpi-label">行 × ${Number(profile.columnCount || 0).toLocaleString()} 列</span>
        </div>
        <div class="kpi-tile"${missingTitle}>
          <span class="kpi-value">${missingCount}</span>
          <span class="kpi-label">缺失列${missingCount === 0 ? "（无缺失）" : ""}</span>
        </div>
        <div class="kpi-tile">
          <span class="kpi-value kpi-value-range">${spanValue}</span>
          <span class="kpi-label">时间跨度 · ${spanLabel}</span>
        </div>
        <div class="kpi-tile"${pkTitle}>
          <span class="kpi-value">${pkSuspicion.length}</span>
          <span class="kpi-label">疑似主键重复</span>
        </div>
      </div>
    `;

    // 候选维度 / 恒定列（保留原明细行，不属于本次 KPI 化范围）
    const dimBits = [];
    if (profile.lowCardinalityColumns && profile.lowCardinalityColumns.length > 0) {
      dimBits.push(`候选维度：${profile.lowCardinalityColumns.slice(0, 5).map((c) => `${escapeHtml(c.name)}(${c.approxUnique})`).join("、")}`);
    }
    if (profile.constantColumns && profile.constantColumns.length > 0) {
      dimBits.push(`恒定列（无区分度）：${profile.constantColumns.slice(0, 5).map(escapeHtml).join("、")}`);
    }
    const dimsHtml = dimBits.length > 0
      ? `<div class="profile-line"><span class="profile-icon">🧩</span><span class="profile-label">维度线索</span><span>${dimBits.join("｜")}</span></div>`
      : "";
    const dimsSection = dimsHtml ? `<div class="profile-sections">${dimsHtml}</div>` : "";

    // 建议问句：chip 列表，每条带「复制」按钮（复制后 toast 提示）
    const questions = profile.suggestedQuestions || [];
    const questionsHtml = questions.length > 0 ? `
      <div class="profile-questions">
        <div class="profile-questions-title">💡 建议问句</div>
        <div class="profile-question-chips">
          ${questions.map((q) => `
            <span class="question-chip">
              <span class="question-chip-text">${escapeHtml(q)}</span>
              <button type="button" class="btn btn-sm chip-copy-btn" onclick="Dashboard.copyQuestion(this, ${JSON.stringify(q).replace(/"/g, "&quot;")})">复制</button>
            </span>
          `).join("")}
        </div>
      </div>
    ` : "";

    return `
      <div class="profile-card">
        <div class="profile-card-header">
          <span class="profile-card-title">📊 数据体检</span>
          <span>${escapeHtml(profile.tableName)}${profile.degraded ? "（大表，仅基础体检）" : ""}</span>
        </div>
        ${kpiRowHtml}
        ${dimsSection}
        ${questionsHtml}
      </div>
    `;
  }

  /** v0.11: 取 ISO 字符串的日期部分（YYYY-MM-DD）；非标准格式原样返回 */
  function toDatePart(v) {
    const s = String(v ?? "");
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
  }

  // ========================================================================
  // Module: 数据预览（v0.10.1：工作台上半区 = 表选择器；下半区 = 前 50 行预览 + 体检卡，
  //          预览容器静态位于 index.html 的 data-preview-section）
  // ========================================================================

  const DatasetsModule = {
    /** showTable 请求展示的表（下次 load 时优先选中，消费后清空） */
    requestedTable: null,
    /** 当前表的数据体检卡（上传响应注入；仅在该表预览时显示） */
    currentProfile: null,
    /** 当前选中的表名（切表取消时用于回退 select 值） */
    currentTableName: null,

    async load() {
      showLoading("datasets-content");
      try {
        const res = await api.fetch("/datasets");
        const datasets = res.data;
        // 缓存列表，删除确认弹窗用它展示表规模
        this.lastDatasets = datasets;

        if (datasets.length === 0) {
          // v0.11 P2: 富空态（沿用原提示文案 + 上传行动按钮）
          document.getElementById("datasets-content").innerHTML = buildEmptyStateHtml(
            "database",
            "暂无数据集。点击右上角「＋ 上传数据」，或在 TUI 中加载数据。",
            '<button class="btn btn-sm btn-primary" onclick="Dashboard.openUploadModal()">＋ 上传数据</button>'
          );
          document.getElementById("dataset-preview").innerHTML =
            '<p class="empty-state">上传或加载数据后，此处显示前 50 行预览。</p>';
          const profileEl = document.getElementById("dataset-profile");
          if (profileEl) profileEl.innerHTML = '<p class="empty-state">暂无体检数据</p>';
          this.currentTableName = null;
          return;
        }

        const lastDataset = localStorage.getItem("dashboard-last-dataset");
        const selected = [this.requestedTable, lastDataset, datasets[0].name]
          .find((name) => name && datasets.some((d) => d.name === name));

        // v0.10.1: 上半区只渲染表选择器顶栏；预览/体检卡容器为静态 DOM（下半区）
        const html = `
          <div style="display:flex;gap:16px;align-items:flex-start">
            <div>
              <label style="font-size:12px;color:var(--muted)">数据集</label>
              <select class="select" id="dataset-select" style="margin-top:4px">
                ${datasets.map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)} (${d.rowCount} rows, ${d.columnCount} cols)</option>`).join("")}
              </select>
            </div>
            <div>
              <label style="font-size:12px;color:var(--muted)">行数</label>
              <select class="select" id="dataset-rows" style="margin-top:4px">
                <option value="10">10</option>
                <option value="50" selected>50</option>
                <option value="100">100</option>
                <option value="200">200</option>
              </select>
            </div>
            <div style="padding-top:20px;display:flex;gap:8px">
              <button class="btn btn-sm" onclick="DatasetsModule.loadStats()">列统计</button>
              <button class="btn btn-sm btn-danger" onclick="DatasetsModule.deleteCurrent()" title="从 DuckDB 中永久删除该表">删除表</button>
            </div>
          </div>
        `;

        document.getElementById("datasets-content").innerHTML = html;

        const select = document.getElementById("dataset-select");
        const rowsSelect = document.getElementById("dataset-rows");
        select.value = selected;
        this.currentTableName = selected;
        select.addEventListener("change", async () => {
          // v0.10.2: 全局切表唯一入口——联动体检卡/表卡片/字典/预览（内含 EditGuard 检查）
          const next = select.value;
          const ok = await Dashboard.selectTable(next);
          if (!ok) select.value = DatasetsModule.currentTableName ?? "";
        });
        rowsSelect.addEventListener("change", () => this.loadPreview(select.value, rowsSelect.value));

        await this.loadPreview(selected, rowsSelect.value);
        // v0.10.2: 体检卡常驻化——上传联动注入的画像直接用，否则走接口拉取
        if (this.currentProfile && this.currentProfile.tableName === selected) {
          this.renderProfileCard(selected);
        } else {
          this.fetchProfile(selected);
        }
      } catch (err) {
        showError("datasets-content", `加载失败: ${err.message}`);
      }
    },

    /**
     * 删除当前选中的表（v0.12）
     *
     * DROP TABLE 不可逆，故前端走 showConfirm 强确认，后端另要求 body.confirm === 表名，
     * 双重防误触。删表只作用于 DuckDB main schema（外部 ATTACH 库不在可选列表里），
     * 源文件与 SQL 历史保留。
     *
     * 删除后联动：清 localStorage 选中态 → 重载列表 → 跟随到剩余首表
     * （表卡片/字段字典分区同步切过去，避免仍指向已删表）。
     */
    async deleteCurrent() {
      const select = document.getElementById("dataset-select");
      const table = select ? select.value : this.currentTableName;
      if (!table) {
        showToast("请先选择要删除的数据表", "warning");
        return;
      }

      // 有未保存的字典/卡片编辑时，删表会让这些编辑失去目标——复用既有丢弃语义
      if (!(await EditGuard.confirmDiscard("删除表将丢失未保存的修改，确定继续？"))) return;

      const meta = (this.lastDatasets || []).find((d) => d.name === table);
      const sizeHint = meta ? `${meta.rowCount} 行 × ${meta.columnCount} 列` : "规模未知";

      const ok = await showConfirm(
        `确定要永久删除数据表「${table}」吗？`,
        {
          title: "删除数据表",
          confirmText: "永久删除",
          cancelText: "取消",
          detail: [
            `规模：${sizeHint}`,
            "",
            "此操作不可撤销，表将从 DuckDB 中彻底移除。",
            "同时清理：查询缓存、表卡片、数据字典条目。",
            "上传的源数据文件不会被删除。",
          ].join("\n"),
        }
      );
      if (!ok) return;

      try {
        await api.fetch(`/datasets/${encodeURIComponent(table)}`, {
          method: "DELETE",
          body: JSON.stringify({ confirm: table }),
        });

        // 清掉指向已删表的选中态，否则下次进入会选中一张不存在的表
        if (localStorage.getItem("dashboard-last-dataset") === table) {
          localStorage.removeItem("dashboard-last-dataset");
        }
        this.currentProfile = null;
        this.currentTableName = null;

        showToast(`已删除表「${table}」`, "success");
        await this.load();

        // load() 已选好剩余首表并写入 currentTableName，据此联动其余分区
        const next = this.currentTableName;
        if (next) {
          TableCardsModule.setTable(next);
          DictionariesModule.setTable(next);
        }
      } catch (err) {
        showToast(`删除失败: ${err.message}`, "error");
      }
    },

    /**
     * v0.10 A-2: 上传成功后由 Dashboard.showUploadedTable 调用——
     * 刷新数据集列表并定位到刚上传的表，附带体检卡（若有）。
     */
    async showTable(tableName, dataProfile) {
      this.requestedTable = tableName;
      this.currentProfile = dataProfile || null;
      try {
        await this.load();
      } finally {
        this.requestedTable = null;
      }
    },

    /** 渲染/清除体检卡（仅在 currentProfile 属于当前表时显示） */
    renderProfileCard(tableName) {
      const container = document.getElementById("dataset-profile");
      if (!container) return;
      const profile = this.currentProfile;
      if (!profile || profile.tableName !== tableName) {
        container.innerHTML = "";
        return;
      }
      container.innerHTML = buildProfileCardHtml(profile);
    },

    /**
     * v0.10.2: 体检卡常驻化——从接口拉取任意选中表的画像。
     * 上传联动场景优先用 loaded.dataProfile 直接渲染，不走这里。
     */
    async fetchProfile(tableName) {
      const container = document.getElementById("dataset-profile");
      if (!container) return;
      container.innerHTML = '<p class="empty-state">体检数据加载中…</p>';
      try {
        const res = await api.fetch(`/datasets/${encodeURIComponent(tableName)}/profile`);
        this.currentProfile = res.data.profile;
        this.renderProfileCard(tableName);
      } catch {
        container.innerHTML = '<p class="empty-state">暂无体检数据</p>';
      }
    },

    async loadPreview(tableName, rows) {
      showLoading("dataset-preview");
      // v0.10 A-3: 预览头部显示表卡片 summary 一行（无卡片显示占位提示）
      renderDatasetCardSummary(tableName);
      try {
        const res = await api.fetch(`/datasets/${encodeURIComponent(tableName)}/preview?rows=${rows}`);
        const { columns, rows: data, totalRowCount, returnedRows, calculationMode } = res.data;

        const modeTag = calculationMode === "full" ? "" : `<span class="tag" style="background:var(--warning-subtle);color:var(--warning);margin-left:4px">${calculationMode}</span>`;

        const html = `
          <div style="color:var(--muted);font-size:12px;margin-bottom:8px">
            ${returnedRows} 行 / ${totalRowCount} 行${modeTag}
          </div>
          <div class="table-container">
            <table class="data-table">
              <thead><tr>${columns.map((c) => `<th>${escapeHtml(c.name)}<br><span style="font-weight:400;opacity:0.7;font-size:10px">${escapeHtml(c.type)}</span></th>`).join("")}</tr></thead>
              <tbody>${data.map((row) => `<tr>${row.map((v) => `<td>${escapeHtml(String(v ?? "NULL"))}</td>`).join("")}</tr>`).join("")}</tbody>
            </table>
          </div>
        `;

        document.getElementById("dataset-preview").innerHTML = html;
      } catch (err) {
        showError("dataset-preview", `预览失败: ${err.message}`);
      }
    },

    async loadStats() {
      const tableName = document.getElementById("dataset-select").value;
      if (!tableName) return;
      showLoading("dataset-stats");
      try {
        const res = await api.fetch(`/datasets/${encodeURIComponent(tableName)}/stats?mode=auto`);
        const { stats, calculationMode, timedOut } = res.data;

        const modeLabel = calculationMode === "full" ? "全量" : calculationMode === "approximate" ? "近似" : "抽样";

        const html = `
          <h3 style="font-size:14px;margin-bottom:8px">列统计 <span class="tag" style="background:var(--warning-subtle);color:var(--warning)">${modeLabel}${timedOut ? " (超时降级)" : ""}</span></h3>
          <div class="table-container">
            <table class="data-table">
              <thead><tr>
                <th>字段</th><th>类型</th><th>空值率</th><th>唯一值</th><th>最小值</th><th>最大值</th><th>均值</th>
              </tr></thead>
              <tbody>${stats.map((s) => `
                <tr>
                  <td style="font-family:var(--font-mono);font-size:12px">${escapeHtml(s.name)}</td>
                  <td style="font-size:11px;color:var(--muted)">${escapeHtml(s.type)}</td>
                  <td>${(s.nullRatio * 100).toFixed(1)}%</td>
                  <td>${s.uniqueCount < 0 ? "-" : s.uniqueCount}</td>
                  <td>${s.min !== undefined ? escapeHtml(String(s.min)) : "-"}</td>
                  <td>${s.max !== undefined ? escapeHtml(String(s.max)) : "-"}</td>
                  <td>${s.avg !== undefined ? s.avg.toFixed(2) : "-"}</td>
                </tr>
              `).join("")}</tbody>
            </table>
          </div>
        `;

        document.getElementById("dataset-stats").innerHTML = html;
      } catch (err) {
        showError("dataset-stats", `统计失败: ${err.message}`);
      }
    },
  };

  // ========================================================================
  // Module: SQL 历史
  // ========================================================================

  const SqlHistoryModule = {
    currentSort: "recent",
    currentStatus: "",
    lastEntries: null,
    currentRevision: 0,

    async load() {
      showLoading("sql-history-content");
      try {
        const res = await api.fetch(`/sql-history?page=1&size=50&sort=${this.currentSort}&status=${this.currentStatus}`);
        const { items, total } = res.data;
        this.currentRevision = res.revision ?? 0;
        this.lastEntries = items;

        if (items.length === 0) {
          // v0.11 P2: 富空态（沿用原提示文案，无应用内行动入口故不带按钮）
          document.getElementById("sql-history-content").innerHTML = buildEmptyStateHtml("history", "暂无 SQL 查询记录。在 TUI 中执行查询后，记录将在此显示。");
          return;
        }

        const html = `
          <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-sm ${this.currentSort === 'recent' ? 'btn-primary' : ''}" onclick="SqlHistoryModule.setSort('recent')">最近使用</button>
            <button class="btn btn-sm ${this.currentSort === 'useCount' ? 'btn-primary' : ''}" onclick="SqlHistoryModule.setSort('useCount')">使用频率</button>
            <span style="color:var(--border)">|</span>
            <button class="btn btn-sm ${this.currentStatus === '' ? 'btn-primary' : ''}" onclick="SqlHistoryModule.setStatus('')">全部</button>
            <button class="btn btn-sm ${this.currentStatus === 'active' ? 'btn-primary' : ''}" onclick="SqlHistoryModule.setStatus('active')">成功</button>
            <button class="btn btn-sm ${this.currentStatus === 'outdated' ? 'btn-primary' : ''}" onclick="SqlHistoryModule.setStatus('outdated')">过时</button>
            <button class="btn btn-sm ${this.currentStatus === 'failed' ? 'btn-primary' : ''}" onclick="SqlHistoryModule.setStatus('failed')">失败</button>
            <button class="btn btn-sm ${this.currentStatus === 'archived' ? 'btn-primary' : ''}" onclick="SqlHistoryModule.setStatus('archived')">已归档</button>
            <span style="color:var(--muted);font-size:12px">${total} 条记录</span>
          </div>
          ${items.map((item) => `
            <div class="card" data-entry-id="${escapeHtml(item.id)}">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
                <div style="flex:1;min-width:0">
                  <div class="card-title">${item.pinned ? '<span title="已固定到长期记忆">📌 </span>' : ""}${escapeHtml(item.naturalLanguageQuery)}</div>
                </div>
                <div style="display:flex;gap:4px;flex-shrink:0">
                  <button class="btn btn-sm" style="font-size:11px" title="${item.pinned ? "取消固定（恢复参与容量淘汰）" : "固定到长期记忆：不参与淘汰，并注入 Agent 导航"}" onclick="SqlHistoryModule.togglePin('${escapeHtml(item.id)}', ${!item.pinned})">${item.pinned ? "取消固定" : "固定"}</button>
                  <button class="btn btn-sm" style="font-size:11px" onclick="SqlHistoryModule.showEditForm('${escapeHtml(item.id)}')">编辑</button>
                </div>
              </div>
              <div class="card-meta">
                <span class="tag ${item.status === 'active' ? 'status-user-confirmed' : item.status === 'failed' ? 'status-uncertain' : 'status-ai-guessed'}">${item.status === "active" ? "成功" : item.status === "failed" ? "失败" : "过时"}</span>
                ${item.pinned ? '<span class="tag status-user-confirmed">📌 已固定</span>' : ""}
                <span style="font-size:11px;color:var(--muted)" title="自动统计的执行次数（与固定相互独立）">执行 ${item.useCount} 次</span>
                <span style="font-size:11px;color:var(--muted)">${formatDate(item.timestamp)}</span>
              </div>
              <div class="sql-code-wrapper">
                <!-- v0.11 P2: 顶部标签条（左 mono「SQL」+ 右「复制」按钮）；复制走全局事件委托 -->
                <div class="sql-code-bar">
                  <span class="sql-code-tag">SQL</span>
                  <button type="button" class="sql-copy-btn" data-sql-copy>复制</button>
                </div>
                <div class="sql-code collapsed" onclick="this.classList.toggle('collapsed')">${escapeHtml(item.sql)}</div>
              </div>
            </div>
          `).join("")}`;

        document.getElementById("sql-history-content").innerHTML = html;
      } catch (err) {
        showError("sql-history-content", `加载失败: ${err.message}`);
      }
    },

    async setSort(sort) {
      this.currentSort = sort;
      await this.load();
    },

    /**
     * v0.10 A-5: 固定/取消固定。走 PATCH /api/sql-history/:entryId 的 pinned 字段，
     * AtomicStore 乐观锁；useCount（自动统计）与 pinned（手动固定）相互独立。
     */
    async togglePin(entryId, pinned) {
      try {
        await api.fetch(`/sql-history/${encodeURIComponent(entryId)}`, {
          method: "PATCH",
          body: JSON.stringify({ pinned, expectedRevision: this.currentRevision }),
        });
        showToast(pinned ? "已固定：不参与容量淘汰，并注入 Agent 导航" : "已取消固定", "success");
        await this.load();
      } catch (err) {
        if (err.status === 409) {
          showToast("数据已被修改（revision 冲突），已刷新，请重试", "warning");
          await this.load();
        } else {
          showToast(`操作失败: ${err.message}`, "error");
        }
      }
    },

    async setStatus(status) {
      this.currentStatus = status;
      await this.load();
    },

    showEditForm(entryId) {
      const entry = this.lastEntries?.find(e => e.id === entryId);
      if (!entry) return;

      const row = document.querySelector(`[data-entry-id="${entryId}"]`);
      if (!row) return;

      // 如果已有编辑面板，先移除
      if (row.nextElementSibling?.classList.contains("edit-panel")) {
        row.nextElementSibling.remove();
        return;
      }

      const panel = document.createElement("div");
      panel.className = "edit-panel";
      panel.innerHTML = `
        <div class="card" style="margin:4px 0;padding:12px">
          <div style="display:flex;flex-direction:column;gap:8px">
            <label style="font-size:12px;color:var(--muted)">自然语言问题</label>
            <input class="inline-edit" id="edit-intent-${entryId}" value="${escapeHtml(entry.naturalLanguageQuery)}" />
            <label style="font-size:12px;color:var(--muted)">备注</label>
            <textarea class="inline-edit" id="edit-notes-${entryId}" rows="2" style="resize:vertical">${escapeHtml(entry.notes || "")}</textarea>
            <label style="font-size:12px;color:var(--muted)">状态</label>
            <select class="inline-edit" id="edit-status-${entryId}">
              <option value="active" ${entry.status === 'active' ? 'selected' : ''}>active</option>
              <option value="outdated" ${entry.status === 'outdated' ? 'selected' : ''}>outdated</option>
              <option value="archived" ${entry.status === 'archived' ? 'selected' : ''}>archived</option>
              <option value="failed" ${entry.status === 'failed' ? 'selected' : ''}>failed</option>
            </select>
            <div style="display:flex;gap:8px">
              <button class="btn btn-sm btn-primary" onclick="SqlHistoryModule.saveEdit('${escapeHtml(entryId)}')">保存</button>
              <button class="btn btn-sm" onclick="SqlHistoryModule.cancelEdit('${escapeHtml(entryId)}')">取消</button>
            </div>
            <span id="edit-msg-${entryId}" class="save-status"></span>
          </div>
        </div>
      `;
      row.after(panel);
    },

    async saveEdit(entryId) {
      const userIntent = document.getElementById(`edit-intent-${entryId}`).value.trim();
      const notes = document.getElementById(`edit-notes-${entryId}`).value.trim();
      const status = document.getElementById(`edit-status-${entryId}`).value;
      const msgEl = document.getElementById(`edit-msg-${entryId}`);

      msgEl.textContent = "保存中...";
      msgEl.className = "save-status saving";

      try {
        await api.fetch(`/sql-history/${encodeURIComponent(entryId)}`, {
          method: "PATCH",
          body: JSON.stringify({ userIntent, notes, status, expectedRevision: this.currentRevision }),
        });
        msgEl.textContent = "已保存";
        msgEl.className = "save-status saved";
        this.cancelEdit(entryId);
        setTimeout(() => this.load(), 500);
      } catch (err) {
        if (err.status === 409) {
          msgEl.innerHTML = `数据已被修改（revision 冲突）。<a href="#" onclick="event.preventDefault();SqlHistoryModule.load();SqlHistoryModule.showEditForm('${entryId}')" style="color:var(--accent2)">刷新后重试</a>`;
        } else {
          msgEl.textContent = `保存失败: ${err.message}`;
        }
        msgEl.className = "save-status error";
      }
    },

    cancelEdit(entryId) {
      const row = document.querySelector(`[data-entry-id="${entryId}"]`);
      if (row?.nextElementSibling?.classList.contains("edit-panel")) {
        row.nextElementSibling.remove();
      }
    },
  };

  // ========================================================================
  // Module: 指标定义（v0.10 A-6：口径管理升级为可维护的指标定义手册）
  //   name + definition 必填；datasets 多选已加载表（get_table_card 关联键）；
  //   notes 选填；旧 caliber 数据降级为只读"历史口径"折叠区
  // ========================================================================

  const MetricsModule = {
    currentRevision: -1,
    metrics: [],
    legacy: [],
    datasets: [],
    /** v0.10.1: 当前处于编辑态的指标 id（null = 全部查看态） */
    editingMetricId: null,

    async load() {
      showLoading("metrics-content");
      try {
        const res = await api.fetch("/metrics");
        const { metrics, legacy, revision } = res.data;
        this.metrics = metrics || [];
        this.legacy = legacy || [];
        this.currentRevision = revision;

        // 已加载数据集（datasets 多选用）；失败不阻塞主列表
        try {
          const dsRes = await api.fetch("/datasets");
          this.datasets = dsRes.data || [];
        } catch { this.datasets = []; }

        window._metricsCache = this.metrics;

        if (this.metrics.length === 0 && this.legacy.length === 0) {
          document.getElementById("metrics-content").innerHTML = `
            <p class="empty-state">暂无指标定义。定义常用指标的计算规则（如 GMV = 已支付订单金额求和），Agent 写 SQL 时会自动遵守。</p>
            <div style="text-align:center;margin-top:16px">
              <button class="btn btn-primary" onclick="MetricsModule.showCreateForm()">新建指标</button>
            </div>`;
          return;
        }

        const html = `
          <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center">
            <span style="color:var(--muted);font-size:12px">${this.metrics.length} 条指标定义${this.legacy.length > 0 ? `，另有 ${this.legacy.length} 条历史口径` : ""}</span>
            <button class="btn btn-sm btn-primary" onclick="MetricsModule.showCreateForm()">新建指标</button>
            <span id="metrics-save-status" class="save-status"></span>
          </div>
          <div id="metrics-list">
            ${this.metrics.length === 0
              ? '<p class="empty-state">暂无指标定义，点击「新建指标」创建。</p>'
              : this.metrics.map((m) => this.renderMetricCard(m)).join("")}
          </div>

          ${this.legacy.length > 0 ? `
          <div class="reports-collapsed-group" style="margin-top:20px">
            <button type="button" class="reports-collapsed-toggle" onclick="MetricsModule.toggleLegacy()">
              <span class="reports-collapsed-arrow" id="legacy-caliber-arrow">▸</span>
              历史口径（只读归档）<span class="count-badge">${this.legacy.length}</span>
              <span class="report-generate-hint">旧版反问确认结论，仅供追溯；如需沿用请新建同义指标</span>
            </button>
            <div id="legacy-caliber-list" style="display:none;margin-top:8px">
              ${this.legacy.map((c) => `
                <div class="card">
                  <div class="card-title" style="font-size:13px">${escapeHtml(c.question)}</div>
                  <div style="margin-top:2px;color:var(--ink);font-size:12px">${escapeHtml(c.definition)}</div>
                  <div class="card-meta">
                    <span class="tag status-ai-guessed">历史口径</span>
                    ${c.appliedAssumption ? `<span style="font-size:11px;color:var(--muted)">前提: ${escapeHtml(c.appliedAssumption)}</span>` : ""}
                    <span style="font-size:11px;color:var(--muted)">${formatDate(c.updatedAt)}</span>
                  </div>
                </div>
              `).join("")}
            </div>
          </div>` : ""}

          <div id="metrics-form-area" style="margin-top:16px"></div>`;

        document.getElementById("metrics-content").innerHTML = html;
      } catch (err) {
        showError("metrics-content", `加载失败: ${err.message}`);
      }
    },

    toggleLegacy() {
      const list = document.getElementById("legacy-caliber-list");
      const arrow = document.getElementById("legacy-caliber-arrow");
      if (!list) return;
      const expanded = list.style.display !== "none";
      list.style.display = expanded ? "none" : "";
      if (arrow) {
        arrow.classList.toggle("expanded", !expanded);
        arrow.textContent = expanded ? "▸" : "▾";
      }
    },

    /** datasets 多选复选框组（已加载的数据集；关联后 get_table_card 会拼入相关口径） */
    renderDatasetChecks(prefix, selected = []) {
      if (this.datasets.length === 0) {
        return '<span style="font-size:12px;color:var(--muted)">当前无已加载数据集，可稍后在编辑中补充关联</span>';
      }
      return `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">
        ${this.datasets.map((d) => `
          <label style="font-size:12px;display:flex;gap:4px;align-items:center;cursor:pointer">
            <input type="checkbox" class="${prefix}-ds-check" value="${escapeHtml(d.name)}" ${selected.includes(d.name) ? "checked" : ""} />
            ${escapeHtml(d.name)}
          </label>
        `).join("")}
      </div>`;
    },

    collectDatasetChecks(prefix) {
      return Array.from(document.querySelectorAll(`.${prefix}-ds-check:checked`)).map((c) => c.value);
    },

    showCreateForm() {
      const area = document.getElementById("metrics-form-area");
      if (!area) return;
      area.innerHTML = `
        <div class="card">
          <div class="card-title">新建指标</div>
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px">
            <input class="inline-edit" id="metric-new-name" placeholder="指标名称 *（例：GMV）" />
            <textarea class="inline-edit" id="metric-new-definition" placeholder="计算规则 *（例：SUM(amount)，仅统计 status='paid' 的订单）" rows="3" style="resize:vertical"></textarea>
            <div>
              <label style="font-size:12px;color:var(--muted)">关联数据集（选填；用于 get_table_card 按表关联注入）</label>
              ${this.renderDatasetChecks("metric-new")}
            </div>
            <textarea class="inline-edit" id="metric-new-notes" placeholder="备注（选填）" rows="1" style="resize:vertical"></textarea>
            <div style="display:flex;gap:8px">
              <button class="btn btn-sm btn-primary" onclick="MetricsModule.createMetric()">保存</button>
              <button class="btn btn-sm" onclick="document.getElementById('metrics-form-area').innerHTML=''">取消</button>
            </div>
            <span id="metric-form-status" class="save-status"></span>
          </div>
        </div>`;
      document.getElementById("metric-new-name").focus();
    },

    /**
     * v0.10.1: 指标卡查看/编辑两态。
     * 查看态 = 只读文本 + [修改] [删除]；编辑态 = 卡片内表单 + [保存] [取消]。
     */
    renderMetricCard(m) {
      const editing = this.editingMetricId === m.id;

      if (!editing) {
        return `
          <div class="card" id="metric-${escapeHtml(m.id)}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
              <div style="min-width:0">
                <div class="card-title">${escapeHtml(m.name)}</div>
                <div style="margin-top:4px;color:var(--ink);font-size:13px">${escapeHtml(m.definition)}</div>
                ${m.notes ? `<div style="margin-top:2px;font-size:12px;color:var(--muted)">备注: ${escapeHtml(m.notes)}</div>` : ""}
                ${m.datasets && m.datasets.length > 0 ? `<div style="margin-top:4px">${m.datasets.map((d) => `<span class="tag tag-dataset">${escapeHtml(d)}</span>`).join("")}</div>` : ""}
              </div>
              <div style="display:flex;gap:4px;flex-shrink:0">
                <button class="btn btn-sm" onclick="MetricsModule.showEditForm('${escapeHtml(m.id)}')">修改</button>
                <button class="btn btn-sm btn-danger" onclick="MetricsModule.remove('${escapeHtml(m.id)}')">删除</button>
              </div>
            </div>
            <div class="card-meta">
              <span class="tag ${m.status === 'user-confirmed' ? 'status-user-confirmed' : 'status-ai-guessed'}">${m.status === "user-confirmed" ? "已确认" : "已替代"}</span>
              <span style="font-size:11px;color:var(--muted)">注入 Agent：是</span>
              <span style="font-size:11px;color:var(--muted)">${formatDate(m.updatedAt)}</span>
            </div>
          </div>
        `;
      }

      return `
        <div class="card metric-card-editing" id="metric-${escapeHtml(m.id)}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div class="card-title">编辑指标</div>
            <span id="metric-form-status" class="save-status"></span>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <input class="inline-edit" id="metric-edit-name" value="${escapeHtml(m.name)}" oninput="MetricsModule.markDirty()" />
            <textarea class="inline-edit" id="metric-edit-definition" rows="3" style="resize:vertical" oninput="MetricsModule.markDirty()">${escapeHtml(m.definition)}</textarea>
            <div>
              <label style="font-size:12px;color:var(--muted)">关联数据集（选填）</label>
              ${this.renderDatasetChecks("metric-edit", m.datasets || [])}
            </div>
            <textarea class="inline-edit" id="metric-edit-notes" rows="1" style="resize:vertical" placeholder="备注（选填）" oninput="MetricsModule.markDirty()">${escapeHtml(m.notes || "")}</textarea>
            <div style="display:flex;gap:8px">
              <button class="btn btn-sm btn-primary" onclick="MetricsModule.updateMetric('${escapeHtml(m.id)}')">保存</button>
              <button class="btn btn-sm" onclick="MetricsModule.cancelMetricEdit()">取消</button>
            </div>
          </div>
        </div>
      `;
    },

    markDirty() {
      if (this.editingMetricId) EditGuard.mark(`metric:${this.editingMetricId}`);
    },

    /** 只重绘指标列表（保留新建表单/历史口径折叠区状态） */
    refreshList() {
      const list = document.getElementById("metrics-list");
      if (!list) return;
      list.innerHTML = this.metrics.length === 0
        ? '<p class="empty-state">暂无指标定义，点击「新建指标」创建。</p>'
        : this.metrics.map((m) => this.renderMetricCard(m)).join("");
    },

    async showEditForm(metricId) {
      if (this.editingMetricId === metricId) return;
      // v0.10.1: 另一张卡在编辑且有未保存更改时先确认
      if (this.editingMetricId && EditGuard.has(`metric:${this.editingMetricId}`)) {
        const ok = await EditGuard.confirmDiscard("切换到其他指标将丢失未保存的修改，确定继续？");
        if (!ok) return;
      }
      this.editingMetricId = metricId;
      EditGuard.unmark(`metric:${metricId}`);
      this.refreshList();
      const input = document.getElementById("metric-edit-name");
      if (input) { input.focus(); input.select(); }
    },

    async cancelMetricEdit() {
      const prev = this.editingMetricId;
      this.editingMetricId = null;
      if (prev) EditGuard.unmark(`metric:${prev}`);
      this.refreshList();
    },

    async createMetric() {
      const name = document.getElementById("metric-new-name").value.trim();
      const definition = document.getElementById("metric-new-definition").value.trim();
      if (!name || !definition) { showToast("名称和计算规则不能为空", "warning"); return; }

      const status = document.getElementById("metric-form-status");
      status.textContent = "保存中...";
      status.className = "save-status saving";
      try {
        const res = await api.fetch("/metrics", {
          method: "POST",
          body: JSON.stringify({
            name,
            definition,
            datasets: this.collectDatasetChecks("metric-new"),
            notes: document.getElementById("metric-new-notes").value.trim(),
            expectedRevision: this.currentRevision,
          }),
        });
        this.currentRevision = res.data.revision ?? this.currentRevision;
        showToast("指标已保存，终端提问将遵守该口径", "success");
        await this.load();
      } catch (err) {
        status.textContent = err.code === "REVISION_CONFLICT" ? "版本冲突，请刷新" : `失败: ${err.message}`;
        status.className = "save-status error";
      }
    },

    async updateMetric(metricId) {
      const name = document.getElementById("metric-edit-name").value.trim();
      const definition = document.getElementById("metric-edit-definition").value.trim();
      if (!name || !definition) { showToast("名称和计算规则不能为空", "warning"); return; }

      const status = document.getElementById("metric-form-status");
      status.textContent = "保存中...";
      status.className = "save-status saving";
      try {
        const res = await api.fetch(`/metrics/${metricId}`, {
          method: "PATCH",
          body: JSON.stringify({
            name,
            definition,
            datasets: this.collectDatasetChecks("metric-edit"),
            notes: document.getElementById("metric-edit-notes").value.trim(),
            expectedRevision: this.currentRevision,
          }),
        });
        this.currentRevision = res.data.revision ?? this.currentRevision;
        // v0.10.1: 保存成功 → 回查看态
        this.editingMetricId = null;
        EditGuard.unmark(`metric:${metricId}`);
        showToast("指标已保存，终端提问将遵守该口径", "success");
        await this.load();
      } catch (err) {
        status.textContent = err.code === "REVISION_CONFLICT" ? "版本冲突，请刷新" : err.code === "LEGACY_READ_ONLY" ? "历史口径只读" : `失败: ${err.message}`;
        status.className = "save-status error";
      }
    },

    async remove(metricId) {
      const ok = await showConfirm("删除此指标定义？Agent 将不再按该口径写 SQL。（软删除，可在 includeArchived 中找回）", { title: "删除指标", confirmText: "删除" });
      if (!ok) return;

      const status = document.getElementById("metrics-save-status");
      try {
        await api.fetch(`/metrics/${metricId}`, {
          method: "DELETE",
          body: JSON.stringify({ expectedRevision: this.currentRevision }),
        });
        EditGuard.unmark(`metric:${metricId}`);
        if (this.editingMetricId === metricId) this.editingMetricId = null;
        showToast("已删除", "success");
        await this.load();
      } catch (err) {
        const msg = err.code === "LEGACY_READ_ONLY" ? "历史口径为归档数据，不可删除" : err.message;
        if (status) {
          status.textContent = `失败: ${msg}`;
          status.className = "save-status error";
        } else {
          showToast(msg, "error");
        }
      }
    },
  };

  // ========================================================================
  // Init
  // ========================================================================

  window.ReportsModule = ReportsModule;
  window.DictionariesModule = DictionariesModule;
  window.TableCardsModule = TableCardsModule;
  window.DatasetsModule = DatasetsModule;

  window.SqlHistoryModule = SqlHistoryModule;
  window.MetricsModule = MetricsModule;

  // Expose to modules
  window.Dashboard = {
    apiFetch: api.fetch.bind(api),
    escapeHtml,
    showToast,
    getWriteToken: () => writeToken,
    toggleTheme() {
      const html = document.documentElement;
      const current = html.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      html.setAttribute("data-theme", next);
      localStorage.setItem("dashboard-theme", next);
      const btn = document.getElementById("theme-toggle-btn");
      if (btn) btn.textContent = next === "dark" ? "🌙" : "☀️";
    },

    refreshPanel(panel) {
      // 重置懒加载标记，强制重新加载
      tabInitialized[panel] = false;
      // 添加旋转动画
      const btn = document.querySelector(`#tab-${panel} .panel-refresh-btn`);
      if (btn) {
        btn.classList.add("spinning");
        setTimeout(() => btn.classList.remove("spinning"), 800);
      }
      switchTab(panel);
    },

    // v0.11 P2: copySql 已移除——SQL 复制按钮统一走下方 document 级事件委托（见「SQL 代码块复制」段）

    /**
     * v0.10 A-2: 复制体检卡建议问句。
     * copyToClipboard 优先走 navigator.clipboard，失败降级 execCommand 并 toast 提示。
     * v0.11: 建议问句改为 chip 列表，按钮文案同步为「复制」。
     */
    copyQuestion(btn, text) {
      if (event) event.stopPropagation();
      copyToClipboard(text);
      btn.classList.add("copied");
      btn.textContent = "已复制";
      setTimeout(() => { btn.classList.remove("copied"); btn.textContent = "复制"; }, 2000);
    },

    /**
     * v0.10.1: 打开上传模态弹窗（数据 Tab 右上角 [＋] 按钮）
     */
    openUploadModal() {
      UploadModule.openModal();
    },

    /**
     * v0.10.2: 全局切表唯一入口——统一 EditGuard 检查并按序联动全部区块：
     * 体检卡 → 表卡片 → 字段字典 → 数据预览。
     * @returns 是否完成切换（false = 用户在未保存确认中取消）
     */
    async selectTable(tableName) {
      const ok = await EditGuard.confirmDiscard("切换表将丢失未保存的修改，确定切换？");
      if (!ok) return false;

      DatasetsModule.currentTableName = tableName;
      EditGuard.unmark("dict");
      DictionariesModule.editingCol = null;
      EditGuard.unmark("tc");
      TableCardsModule.mode = "view";
      localStorage.setItem("dashboard-last-dataset", tableName);

      // ② 体检卡：清掉上一张表的画像后走接口拉取目标表
      DatasetsModule.currentProfile = null;
      DatasetsModule.fetchProfile(tableName);
      // ⑤ 数据预览
      const rowsSel = document.getElementById("dataset-rows");
      DatasetsModule.loadPreview(tableName, rowsSel ? rowsSel.value : 50);
      // ③ 表卡片
      TableCardsModule.setTable(tableName);
      // ④ 字段字典
      DictionariesModule.setTable(tableName);
      return true;
    },

    /**
     * v0.10 A-2: 上传成功（loaded.ok）后的联动——
     * 定位到该表的预览 + 体检卡 + 建议问句（下半区）。
     * v0.10.2: 表卡片/字段字典分区同步跟随全局选择切到新表。
     * 联动失败只影响展示，不影响已成功的上传/建表。
     */
    async showUploadedTable(loaded) {
      switchTab("data");
      try {
        await DatasetsModule.showTable(loaded.tableName, loaded.dataProfile || null);
        TableCardsModule.setTable(loaded.tableName);
        await DictionariesModule.setTable(loaded.tableName);
      } catch (err) {
        console.warn("[Dashboard] showUploadedTable failed:", err.message);
        showToast(`预览联动失败: ${err.message}`, "warning");
      }
    },
  };

  // 设置初始主题图标
  const initTheme = document.documentElement.getAttribute("data-theme");
  const themeBtn = document.getElementById("theme-toggle-btn");
  if (themeBtn) themeBtn.textContent = initTheme === "light" ? "☀️" : "🌙";

  // ========================================================================
  // v0.11 P2: SQL 代码块复制——document 级事件委托，集中绑定一次，
  // 覆盖任意渲染点生成的 [data-sql-copy] 按钮；复制内容取自同区块 .sql-code 的文本
  // ========================================================================

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".sql-copy-btn[data-sql-copy]");
    if (!btn) return;
    e.stopPropagation();
    const code = btn.closest(".sql-code-wrapper")?.querySelector(".sql-code");
    if (!code) return;
    copyToClipboard(code.textContent || "");
    btn.classList.add("copied");
    btn.textContent = "已复制";
    setTimeout(() => { btn.classList.remove("copied"); btn.textContent = "复制"; }, 2000);
  });

  // 全局键盘快捷键
  document.addEventListener("keydown", (e) => {
    // Alt+1~3 切换 Tab（v0.10.1：3 Tab）
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const idx = parseInt(e.key, 10) - 1;
      if (idx >= 0 && idx < VALID_TABS.length) {
        e.preventDefault();
        switchTab(VALID_TABS[idx]);
        return;
      }
    }
    // Esc 关闭报告弹窗（上传弹窗有自己的捕获阶段 Esc 处理）
    if (e.key === "Escape") {
      const reportModal = document.getElementById("report-modal");
      if (reportModal) { reportModal.remove(); return; }
    }
  });

  async function init() {
    try {
      const res = await api.fetch("/config");
      writeToken = res.data.writeToken;

      // 缓存口径数据（用于编辑）
      try {
        const metricsRes = await api.fetch("/metrics");
        window._metricsCache = metricsRes.data.metrics;
      } catch { /* 忽略 */ }

    console.log("[Dashboard] Initialized");

    // 绑定报告搜索框事件（骨架保留在 DOM 中，只需绑定一次）
    ReportsModule.bindSearchEvents();

    // 初始化完成后，恢复上次访问的 tab（此时所有模块已定义）
    // v0.10.1: 旧版本 last-tab key（v1/v2）读到即丢弃（不迁移不报错）
    LEGACY_LAST_TAB_KEYS.forEach((k) => localStorage.removeItem(k));
    // v0.11: 无 last-tab 或值不合法时也显式初始化默认面板——
    // 全新环境（含 v3 key 升级后老用户首访）此前不会触发懒加载，
    // 默认 active 的「数据」面板停留在静态占位直到手动切 Tab。
    // switchTab 对已是 active 的面板幂等（classList.toggle 强制布尔），重复调用安全。
    const lastTab = localStorage.getItem(LAST_TAB_KEY);
    switchTab(lastTab && VALID_TABS.includes(lastTab) ? lastTab : "data");
  } catch (err) {
      console.warn("[Dashboard] Init failed:", err.message);
      document.querySelectorAll(".panel-body").forEach((el) => {
        el.innerHTML = `<p class="empty-state">无法连接到 API 服务: ${escapeHtml(err.message)}</p>`;
      });
    }
  }

  init();
})();
