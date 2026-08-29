/**
 * Pi Data Agent — SQL 标识符引用（R-1 收敛：单一出处）
 *
 * 语义统一说明（R-1）：
 * 此前存在两套分叉实现——engine/duckdb.ts 的"白名单正则 + 抛异常"与
 * dashboard/services/dataset-reader.ts 的 `""` 转义。现统一采用 `""` 转义语义
 * （DuckDB 标准：标识符内的双引号翻倍转义，可安全承载任意合法名称），
 * 同时保留非法字符防护：含控制字符（NUL/CR/LF）的名称直接拒绝，
 * 防止借控制字符绕过引号语义注入。
 */

/** 控制字符（NUL/CR/LF 等）——即使在引号内也会破坏语句结构，直接拒绝 */
const ILLEGAL_IDENTIFIER_CHARS = /[\0\r\n]/;

/**
 * 安全引用 SQL 标识符：`"` → `""` 转义后包裹双引号。
 *
 * @throws 名称含 NUL/CR/LF 等控制字符时抛错
 */
export function quoteSqlIdentifier(name: string): string {
  if (ILLEGAL_IDENTIFIER_CHARS.test(name)) {
    throw new Error(`Invalid identifier: ${JSON.stringify(name)}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}
