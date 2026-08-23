/**
 * Pi Data Agent Dashboard — 原子写入 + Revision 管理
 *
 * 职责：
 * 1. 读取 JSON 文件时返回 RevisionedData<T>
 * 2. 写入时：写临时文件 → 解析校验 → rename 原子替换
 * 3. 每次写入递增 revision + 更新 updatedAt
 * 4. 客户端携带 expectedRevision，版本不一致返回 409
 * 5. 写失败时保留旧文件
 * 6. 所有修改写入审计日志
 *
 * 复用现有 PersistenceManager 的路径管理，不另建平行体系。
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { RevisionedData } from "../types.js";

/** 自定义错误类型 */
export class RevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "RevisionConflictError";
  }
}

export class AtomicStoreError extends Error {
  readonly code = "ATOMIC_STORE_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "AtomicStoreError";
  }
}

/** 审计日志写入回调（注入外部 AuditLogManager） */
export type AuditLogWriter = (entry: {
  action: string;
  target: string;
  field?: string;
  before?: string;
  after?: string;
}) => void;

/**
 * 原子存储管理器
 *
 * @template T — 存储的数据类型
 */
export class AtomicStore<T> {
  private filePath: string;
  private lock = false; // 同一进程内串行化写操作
  private currentRevision = 0;
  private auditWriter?: AuditLogWriter;

  constructor(filePath: string, auditWriter?: AuditLogWriter) {
    this.filePath = filePath;
    this.auditWriter = auditWriter;
    // 确保目录存在
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch {
      // 忽略
    }
    // 初始化 revision（从已有文件读取）
    const existing = this.read();
    if (existing) {
      this.currentRevision = existing.revision;
    }
  }

  /**
   * 读取数据
   * @returns RevisionedData<T> 或 null（文件不存在时）
   */
  read(): RevisionedData<T> | null {
    if (!existsSync(this.filePath)) {
      return null;
    }

    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as RevisionedData<T>;
      this.currentRevision = parsed.revision;
      return parsed;
    } catch (err) {
      console.warn(`[AtomicStore] Failed to read ${this.filePath}:`, err);
      // 尝试读取备份
      return this.readBackup();
    }
  }

  /**
   * 原子写入数据（带 revision 检查）
   *
   * @param data - 新数据
   * @param expectedRevision - 客户端期望的版本号
   * @param auditTarget - 审计日志目标标识（如表名、口径 ID）
   * @param auditBefore - 变更前的摘要（用于审计日志）
   * @throws RevisionConflictError — revision 不一致
   * @throws AtomicStoreError — 写入失败
   */
  write(
    data: T,
    expectedRevision: number,
    auditTarget: string,
    auditBefore?: string,
  ): RevisionedData<T> {
    // 串行化
    if (this.lock) {
      throw new AtomicStoreError("存储正在写入中，请稍后重试");
    }
    this.lock = true;

    try {
      // 检查 revision
      if (expectedRevision !== -1 && expectedRevision !== this.currentRevision) {
        throw new RevisionConflictError(
          `数据已被其他进程更新（当前版本: ${this.currentRevision}，期望版本: ${expectedRevision}），请刷新后重试`
        );
      }

      const newRevision = this.currentRevision + 1;
      const updatedAt = new Date().toISOString();

      const wrapped: RevisionedData<T> = {
        data,
        revision: newRevision,
        updatedAt,
      };

      const content = JSON.stringify(wrapped, null, 2);

      // 写入临时文件
      const tmpPath = this.filePath + `.tmp_${randomUUID()}`;
      writeFileSync(tmpPath, content, "utf-8");

      // 解析校验临时文件
      try {
        JSON.parse(readFileSync(tmpPath, "utf-8"));
      } catch {
        unlinkSync(tmpPath);
        throw new AtomicStoreError("写入校验失败，数据未保存");
      }

      // 原子替换
      try {
        // 备份旧文件（如果存在）
        if (existsSync(this.filePath)) {
          renameSync(this.filePath, this.filePath + ".bak");
        }
        renameSync(tmpPath, this.filePath);
      } catch (err) {
        // 回滚：恢复备份
        if (existsSync(this.filePath + ".bak")) {
          renameSync(this.filePath + ".bak", this.filePath);
        }
        if (existsSync(tmpPath)) {
          unlinkSync(tmpPath);
        }
        throw new AtomicStoreError(
          `原子替换失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // 成功：更新内存 revision
      this.currentRevision = newRevision;

      // 清理备份
      try {
        if (existsSync(this.filePath + ".bak")) {
          unlinkSync(this.filePath + ".bak");
        }
      } catch {
        // 忽略
      }

      // 审计日志
      if (this.auditWriter) {
        this.auditWriter({
          action: "write",
          target: auditTarget,
          before: auditBefore,
          after: JSON.stringify(data).slice(0, 200),
        });
      }

      console.log(
        `[AtomicStore] Written to ${this.filePath} (revision: ${newRevision})`
      );

      return wrapped;
    } finally {
      this.lock = false;
    }
  }

  /**
   * 获取当前 revision（不读文件）
   */
  getRevision(): number {
    return this.currentRevision;
  }

  /** 从备份恢复 */
  private readBackup(): RevisionedData<T> | null {
    const bakPath = this.filePath + ".bak";
    if (existsSync(bakPath)) {
      try {
        const raw = readFileSync(bakPath, "utf-8");
        const parsed = JSON.parse(raw) as RevisionedData<T>;
        console.warn(`[AtomicStore] Recovered from backup: ${bakPath}`);
        return parsed;
      } catch {
        // 备份也损坏
      }
    }
    return null;
  }
}
