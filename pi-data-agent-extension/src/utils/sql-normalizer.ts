/**
 * SQL标准化工具函数，用于统一SQL格式，避免差异导致匹配/缓存失败
 */

/** 标准化SQL */
export function normalizeSql(sql: string): string {
  try {
    return sql
      .replace(/--.*$/gm, "") // 移除注释
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ") // 多个空格合并为一个
      .replace(/;\s*$/, "") // 去掉末尾分号
      .trim()
      .toUpperCase();
  } catch {
    return sql;
  }
}