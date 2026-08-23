-- stats-summary.sql — 分组描述统计
--
-- 用途：按分类字段输出 count / mean / median / min / max / stddev
-- 适用：了解数据整体分布、分组对比
-- 要求：group_col 为分类/维度字段，metric_col 为数值字段
--
-- 参数：
--   :group_col   — 分组字段名（如 category, channel, status）
--   :metric_col  — 数值字段名（如 amount, sales, score）
--   :table       — 表名

SELECT
  :group_col AS dimension,
  COUNT(*) AS cnt,
  ROUND(AVG(:metric_col), 4) AS mean,
  MEDIAN(:metric_col) AS median,
  MIN(:metric_col) AS min_val,
  MAX(:metric_col) AS max_val,
  ROUND(STDDEV(:metric_col), 4) AS stddev,
  ROUND(COUNT(*) FILTER (WHERE :metric_col IS NULL) * 100.0 / COUNT(*), 2) AS null_pct
FROM :table
GROUP BY :group_col
ORDER BY mean DESC;

-- 变体：不分组的整体描述统计（去掉 GROUP BY）
-- SELECT
--   COUNT(*) AS cnt,
--   ROUND(AVG(:metric_col), 4) AS mean,
--   MEDIAN(:metric_col) AS median,
--   MIN(:metric_col) AS min_val,
--   MAX(:metric_col) AS max_val,
--   ROUND(STDDEV(:metric_col), 4) AS stddev
-- FROM :table;
