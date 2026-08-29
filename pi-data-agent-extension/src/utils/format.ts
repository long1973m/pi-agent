/**
 * Pi Data Agent — 通用格式化工具（R-1 收敛：单一出处）
 */

/** 格式化文件大小（原 tools/load-data、tools/export-result、dashboard/routes/upload 三处副本收敛于此） */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
