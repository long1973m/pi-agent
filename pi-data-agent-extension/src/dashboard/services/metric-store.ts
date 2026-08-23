/**
 * Dashboard — 指标定义 Store（v0.10 A-6：口径管理 → 指标定义）
 *
 * 数据模型沿用 MetricEntry：{ id, name, definition(计算规则), datasets[], status, notes }。
 * - 新建/编辑/删除（软删）走 AtomicStore：revision 乐观锁 + 原子写 + 审计日志
 * - 旧 caliber 数据（agent.md 反问确认结论）迁移为只读"历史口径"：
 *   标记 legacyCaliber=true，不参与常规 CRUD 与 L0 指标注入，保留不丢
 *
 * 迁移防错乱设计（v0.10）：
 * - agent.md → metrics.json 为【增量幂等】导入：逐条检查 question/name 是否已存在，
 *   已存在则跳过——不会因重复构造 MetricStore 或 agent.md 后续变化而二次迁移出重复条目
 * - syncToAgentMd 只把 legacy 条目回写到 agent.md（保持历史通道），新定义不再镜像，
 *   避免"User Confirmed Calibers"与 L0 指标注入在 system prompt 中重复
 */

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import type { CaliberEntry } from "../../types.js";
import type { MetricEntry, RevisionedData } from "../types.js";
import { AtomicStore, RevisionConflictError } from "./atomic-store.js";

export { RevisionConflictError };

/** legacy 历史口径为只读归档 */
export class LegacyReadOnlyError extends Error {
  readonly code = "LEGACY_READ_ONLY";
  constructor(message = "该条目是旧口径迁移的历史数据，只读不可编辑") {
    super(message);
    this.name = "LegacyReadOnlyError";
  }
}

/** 判断是否为旧口径迁移来的历史条目（含旧版迁移未打标记、但带 question 字段的条目） */
export function isLegacyMetric(metric: MetricEntry): boolean {
  return metric.legacyCaliber === true || typeof metric.question === "string";
}

/**
 * 指标定义 Store
 */
export class MetricStore {
  private atomicStore: AtomicStore<MetricEntry[]>;
  private agentMdPath: string;
  private auditLogPath: string;

  constructor(projectDir: string) {
    const metricsPath = join(projectDir, "metrics.json");
    this.agentMdPath = join(projectDir, "agent.md");
    this.auditLogPath = join(projectDir, "audit.log");

    const auditWriter = (entry: {
      action: string;
      target: string;
      field?: string;
      before?: string;
      after?: string;
    }) => {
      this.writeAuditLog(entry);
    };

    this.atomicStore = new AtomicStore<MetricEntry[]>(metricsPath, auditWriter);

    // agent.md 口径 → metrics.json 历史口径（增量幂等导入）
    this.migrateFromAgentMd();
  }

  /** 判断某 id 的条目是否为 legacy（不存在返回 null） */
  isLegacy(metricId: string): boolean | null {
    const data = this.atomicStore.read();
    const entry = data?.data.find((m) => m.id === metricId);
    if (!entry) return null;
    return isLegacyMetric(entry);
  }

  /**
   * 获取活跃指标定义（排除已归档与 legacy 历史口径）
   */
  list(params?: { includeArchived?: boolean }): {
    metrics: MetricEntry[];
    revision: number;
  } {
    const data = this.atomicStore.read();
    const revision = data?.revision ?? 0;
    let metrics = (data?.data ?? []).filter((m) => !isLegacyMetric(m));

    if (!params?.includeArchived) {
      metrics = metrics.filter((m) => !m.archived);
    }

    return { metrics, revision };
  }

  /**
   * 获取只读历史口径（legacy；含迁移时即 superseded/归档的条目——历史区保留全部迁移记录）
   */
  listLegacy(): { legacy: MetricEntry[]; revision: number } {
    const data = this.atomicStore.read();
    return {
      legacy: (data?.data ?? []).filter((m) => isLegacyMetric(m)),
      revision: data?.revision ?? 0,
    };
  }

  /** 获取单个指标定义 */
  get(metricId: string): MetricEntry | null {
    const data = this.atomicStore.read();
    const entry = data?.data?.find((m) => m.id === metricId) ?? null;
    return entry && !entry.archived ? entry : null;
  }

  /**
   * 新增指标定义（name/definition 必填由路由校验）
   */
  create(
    entry: Omit<MetricEntry, "id" | "revision" | "updatedAt" | "archived">,
    expectedRevision: number,
  ): RevisionedData<MetricEntry[]> {
    const data = this.atomicStore.read();
    const entries = data?.data ?? [];

    // 生成 ID
    const id = `metric_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const newEntry: MetricEntry = {
      ...entry,
      id,
      revision: 0,
      updatedAt: new Date().toISOString(),
      archived: false,
    };

    entries.push(newEntry);

    const result = this.atomicStore.write(entries, expectedRevision, `metric:${id}`);

    // 同步 legacy 口径回 agent.md（保持历史通道；新定义不镜像）
    this.syncToAgentMd(entries);

    return result;
  }

  /**
   * 更新指标定义（legacy 历史口径拒绝）
   */
  update(
    metricId: string,
    updates: Partial<Pick<MetricEntry, "name" | "definition" | "datasets" | "status" | "notes" | "appliedAssumption">>,
    expectedRevision: number,
  ): RevisionedData<MetricEntry[]> {
    const data = this.atomicStore.read();
    if (!data) throw new RevisionConflictError("指标数据不存在");

    const target = data.data.find((m) => m.id === metricId);
    if (!target) throw new RevisionConflictError("指标数据不存在");
    if (isLegacyMetric(target)) throw new LegacyReadOnlyError();

    const entries = data.data.map((m) => {
      if (m.id !== metricId) return m;
      return {
        ...m,
        ...updates,
        updatedAt: new Date().toISOString(),
      };
    });

    const result = this.atomicStore.write(entries, expectedRevision, `metric:${metricId}`);
    this.syncToAgentMd(entries);
    return result;
  }

  /**
   * 软删除（归档）；legacy 历史口径拒绝删除（保留不丢）
   */
  archive(metricId: string, expectedRevision: number): RevisionedData<MetricEntry[]> {
    const data = this.atomicStore.read();
    if (!data) throw new RevisionConflictError("指标数据不存在");

    const target = data.data.find((m) => m.id === metricId);
    if (!target) throw new RevisionConflictError("指标数据不存在");
    if (isLegacyMetric(target)) throw new LegacyReadOnlyError("历史口径为归档数据，不可删除");

    const entries = data.data.map((m) => {
      if (m.id !== metricId) return m;
      return { ...m, archived: true, updatedAt: new Date().toISOString() };
    });

    const result = this.atomicStore.write(entries, expectedRevision, `metric:${metricId}`);
    this.syncToAgentMd(entries.filter((m) => !m.archived));
    return result;
  }

  // =========================================================================
  // Private
  // =========================================================================

  /**
   * 从 agent.md 增量幂等导入口径为只读历史条目。
   *
   * 防二次迁移错乱：
   * - 按 caliber.question 与已有条目的 question / name 双向去重
   * - metrics.json 已有任意同名/同问条目 → 跳过该条（不整体跳过，可拾取新增的 runtime 口径确认）
   */
  private migrateFromAgentMd(): void {
    if (!existsSync(this.agentMdPath)) return;

    try {
      const raw = readFileSync(this.agentMdPath, "utf-8");
      const calibers = JSON.parse(raw) as CaliberEntry[];
      if (!Array.isArray(calibers) || calibers.length === 0) return;

      const existing = this.atomicStore.read();
      const entries = existing?.data ?? [];
      const knownQuestions = new Set(
        entries.map((m) => [m.question, m.name].filter((v): v is string => typeof v === "string")).flat()
      );

      let appended = 0;
      for (const c of calibers) {
        if (!c || typeof c.question !== "string" || typeof c.definition !== "string") continue;
        if (knownQuestions.has(c.question)) continue;

        entries.push({
          id: c.id || `metric_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: c.question,
          definition: c.definition,
          datasets: [],
          status: c.status === "confirmed" ? "user-confirmed" as const : "superseded" as const,
          source: "user" as const,
          revision: 0,
          updatedAt: c.confirmedAt || new Date().toISOString(),
          archived: c.status === "superseded",
          question: c.question,
          appliedAssumption: c.appliedAssumption,
          legacyCaliber: true,
        });
        knownQuestions.add(c.question);
        appended++;
      }

      if (appended > 0) {
        console.log(`[MetricStore] Imported ${appended} legacy calibers from agent.md (read-only history)`);
        // 直接写入（迁移不需要 revision 检查）
        this.atomicStore.write(entries, -1, "migration:agent-md");
      }
    } catch {
      // 不是合法 JSON 的 agent.md，跳过（不阻塞启动）
    }
  }

  /**
   * 同步 legacy 口径回 agent.md（保持兼容现有 caliber 上下文加载）。
   * v0.10 起：仅镜像 legacyCaliber 条目；用户维护的指标定义只住 metrics.json +
   * L0 导航层注入，避免 system prompt 双份。
   *
   * 合并语义：先读盘上 agent.md 现有内容（可能含 runtime 刚写入、尚未导入的新口径），
   * 再用 legacy 条目按 question 覆盖——绝不丢弃未迁移的运行时口径。
   */
  private syncToAgentMd(metrics: MetricEntry[]): void {
    try {
      const merged = new Map<string, CaliberEntry>();

      // 1. 盘上现有内容优先占位（含 runtime 新写、下次构造时才导入的条目）
      if (existsSync(this.agentMdPath)) {
        try {
          const existing = JSON.parse(readFileSync(this.agentMdPath, "utf-8")) as CaliberEntry[];
          if (Array.isArray(existing)) {
            for (const c of existing) {
              if (c && typeof c.question === "string") merged.set(c.question, c);
            }
          }
        } catch {
          // 原文件不是合法 JSON → 以 legacy 为准重建
        }
      }

      // 2. legacy 条目覆盖同名 question
      for (const m of metrics) {
        if (!isLegacyMetric(m) || m.archived) continue;
        merged.set(m.question ?? m.name, {
          id: m.id,
          question: m.question ?? m.name,
          definition: m.definition,
          appliedAssumption: m.appliedAssumption || "",
          confirmedAt: m.updatedAt,
          status: m.status === "user-confirmed" ? "confirmed" as const : "superseded" as const,
        });
      }

      writeFileSync(this.agentMdPath, JSON.stringify([...merged.values()], null, 2), "utf-8");
    } catch {
      // 写入失败不影响主流程
    }
  }

  private writeAuditLog(entry: {
    action: string;
    target: string;
    before?: string;
    after?: string;
  }): void {
    try {
      mkdirSync(join(this.auditLogPath, ".."), { recursive: true });
      const logEntry = {
        id: `al_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        toolName: "dashboard",
        action: `metric:${entry.action}`,
        actor: "user",
        durationMs: 0,
        result: "success" as const,
        summary: `${entry.action}: ${entry.target}`,
      };
      appendFileSync(
        this.auditLogPath,
        JSON.stringify(logEntry) + "\n",
        "utf-8"
      );
    } catch {
      // 忽略
    }
  }
}
