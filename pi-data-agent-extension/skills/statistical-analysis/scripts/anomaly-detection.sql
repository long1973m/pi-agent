-- anomaly-detection.sql — 异常值检测（IQR 方法）
--
-- 用途：基于四分位距（IQR）找出极端值
-- 适用：发现异常高/低的记录
-- 方法：异常值 = 值 < Q1 - 1.5*IQR 或 值 > Q3 + 1.5*IQR
--
-- 参数：
--   :metric_col  — 数值字段名
--   :table       — 表名
--   :id_col      — 标识字段名（用于定位异常记录，可选）
--   :top_n       — 返回前 N 个异常值（默认 20）

WITH stats AS (
  SELECT
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY :metric_col) AS q1,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY :metric_col) AS q3
  FROM :table
),
bounds AS (
  SELECT
    q1,
    q3,
    q3 - q1 AS iqr,
    q1 - 1.5 * (q3 - q1) AS lower_bound,
    q3 + 1.5 * (q3 - q1) AS upper_bound
  FROM stats
)
SELECT
  :id_col AS record_id,
  :metric_col AS value,
  b.lower_bound,
  b.upper_bound,
  CASE
    WHEN :metric_col < b.lower_bound THEN 'low_outlier'
    WHEN :metric_col > b.upper_bound THEN 'high_outlier'
  END AS anomaly_type
FROM :table t
CROSS JOIN bounds b
WHERE :metric_col < b.lower_bound OR :metric_col > b.upper_bound
ORDER BY ABS(:metric_col - (b.q1 + b.q3) / 2) DESC
LIMIT COALESCE(:top_n, 20);

-- 变体：Z-score 方法（适用于近似正态分布的数据）
-- WITH stats AS (
--   SELECT AVG(:metric_col) AS mean_val, STDDEV(:metric_col) AS stddev_val FROM :table
-- )
-- SELECT
--   :id_col AS record_id,
--   :metric_col AS value,
--   ABS((:metric_col - mean_val) / stddev_val) AS z_score
-- FROM :table t, stats
-- WHERE ABS((:metric_col - mean_val) / stddev_val) > 3
-- ORDER BY z_score DESC
-- LIMIT 20;
