/**
 * Data Cleaning Skill — SQL 检查模板
 *
 * 本文件提供数据质量检查的 SQL 查询模板，供 Agent 参考使用。
 * 模板中的占位符需要替换为实际的表名和字段名。
 *
 * 占位符约定：
 *   {table}     — 目标表名
 *   {col}       — 目标字段名
 *   {cols}      — 多个字段名（逗号分隔）
 *   {key_cols}  — 主键/唯一标识字段（逗号分隔）
 *   {threshold} — 阈值（数值）
 */

-- ============================================================================
-- 1. 缺失值检查
-- 用途：发现 NULL 值分布，评估数据完整性
-- ============================================================================

-- 全表 NULL 概览：每列的 NULL 数量和占比
SELECT
  '{col}' AS column_name,
  COUNT(*) AS total_rows,
  SUM(CASE WHEN {col} IS NULL THEN 1 ELSE 0 END) AS null_count,
  ROUND(100.0 * SUM(CASE WHEN {col} IS NULL THEN 1 ELSE 0 END) / COUNT(*), 2) AS null_percentage
FROM {table};

-- 多列 NULL 统计（一次性检查所有字段）
SELECT
  COUNT(*) AS total_rows
  {, SUM(CASE WHEN {col_n} IS NULL THEN 1 ELSE 0 END) AS {col_n}_nulls}
  {, ROUND(100.0 * SUM(CASE WHEN {col_n} IS NULL THEN 1 ELSE 0 END) / COUNT(*), 2) AS {col_n}_null_pct}
FROM {table};

-- 行级 NULL 严重度：每行有多少列是 NULL
SELECT
  NULL_COUNT,
  COUNT(*) AS row_count
FROM (
  SELECT
    {cols_comma_case_null} AS nulls,
    {cols_null_count_expr} AS NULL_COUNT
  FROM {table}
)
GROUP BY NULL_COUNT
ORDER BY NULL_COUNT;

-- ============================================================================
-- 2. 重复值检查
-- 用途：发现重复行和重复字段值
-- ============================================================================

-- 完全重复行（所有列都相同）
SELECT
  {cols},
  COUNT(*) AS duplicate_count
FROM {table}
GROUP BY {cols}
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC;

-- 基于主键的重复检查
SELECT
  {key_cols},
  COUNT(*) AS duplicate_count
FROM {table}
GROUP BY {key_cols}
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC;

-- 单列重复值检查（高基数列如 email/phone）
SELECT
  {col},
  COUNT(*) AS occurrence_count
FROM {table}
WHERE {col} IS NOT NULL
GROUP BY {col}
HAVING COUNT(*) > 1
ORDER BY occurrence_count DESC
LIMIT 20;

-- 重复行总数
SELECT
  COUNT(*) - COUNT(DISTINCT {cols}) AS duplicate_row_count,
  ROUND(100.0 * (COUNT(*) - COUNT(DISTINCT {cols})) / COUNT(*), 2) AS duplicate_percentage
FROM {table};

-- ============================================================================
-- 3. 异常值检查
-- 用途：发现数值列中的异常值
-- ============================================================================

-- 基础统计（min/max/avg/q1/q3/IQR）
SELECT
  MIN({col}) AS min_val,
  MAX({col}) AS max_val,
  AVG({col}) AS avg_val,
  APPROX_QUANTILE({col}, 0.25) AS q1,
  APPROX_QUANTILE({col}, 0.5) AS median,
  APPROX_QUANTILE({col}, 0.75) AS q3,
  APPROX_QUANTILE({col}, 0.75) - APPROX_QUANTILE({col}, 0.25) AS iqr
FROM {table}
WHERE {col} IS NOT NULL;

-- IQR 异常值检测（超出 Q1 - 1.5*IQR ~ Q3 + 1.5*IQR 的值）
SELECT *
FROM {table}
WHERE {col} IS NOT NULL
  AND {col} < (
    SELECT APPROX_QUANTILE({col}, 0.25) - 1.5 * (APPROX_QUANTILE({col}, 0.75) - APPROX_QUANTILE({col}, 0.25))
    FROM {table}
  )
  OR {col} > (
    SELECT APPROX_QUANTILE({col}, 0.75) + 1.5 * (APPROX_QUANTILE({col}, 0.75) - APPROX_QUANTILE({col}, 0.25))
    FROM {table}
  )
ORDER BY {col};

-- Z-score 异常值检测（|z| > 3 的值）
WITH stats AS (
  SELECT AVG({col}) AS mean_val, STDDEV_POP({col}) AS std_val
  FROM {table} WHERE {col} IS NOT NULL
)
SELECT t.*
FROM {table} t, stats
WHERE t.{col} IS NOT NULL
  AND ABS(t.{col} - stats.mean_val) / NULLIF(stats.std_val, 0) > 3
ORDER BY t.{col};

-- 负值检查（适用于本应为正数的字段如年龄、金额、数量）
SELECT COUNT(*) AS negative_count
FROM {table}
WHERE {col} IS NOT NULL AND {col} < 0;

-- ============================================================================
-- 4. 格式一致性检查
-- 用途：发现字段值格式不一致的问题
-- ============================================================================

-- 前后空格检查
SELECT COUNT(*) AS leading_space_count
FROM {table}
WHERE {col} IS NOT NULL AND {col} LIKE ' %';

SELECT COUNT(*) AS trailing_space_count
FROM {table}
WHERE {col} IS NOT NULL AND {col} LIKE '% ';

-- 大小写不一致检查
SELECT
  {col},
  COUNT(*) AS count
FROM {table}
WHERE {col} IS NOT NULL
GROUP BY LOWER({col})
HAVING COUNT(DISTINCT {col}) > 1
ORDER BY count DESC
LIMIT 20;

-- ============================================================================
-- 5. 辅助查询
-- ============================================================================

-- 字段类型检查
DESCRIBE {table};

-- 表行数
SELECT COUNT(*) AS total_rows FROM {table};

-- 数值列列表
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = '{table}'
  AND data_type IN ('DOUBLE', 'INTEGER', 'FLOAT', 'DECIMAL', 'BIGINT')
ORDER BY ordinal_position;
