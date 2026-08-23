-- trend-analysis.sql — 按时间字段聚合，计算环比变化率
--
-- 用途：观察数值指标随时间的变化趋势
-- 适用：时间序列数据的趋势判断
-- 要求：time_col 为日期/时间类型，metric 为数值字段
--
-- 参数：
--   :time_col   — 时间字段名（如 date, order_time, created_at）
--   :metric     — 数值字段名（如 amount, sales, count）
--   :table      — 表名
--   :period     — 聚合周期：'day', 'week', 'month'（默认 'month'）

WITH period_agg AS (
  SELECT
    DATE_TRUNC(COALESCE(:period, 'month'), :time_col) AS period,
    SUM(:metric) AS total,
    COUNT(*) AS record_count
  FROM :table
  GROUP BY 1
  ORDER BY 1
)
SELECT
  period,
  total,
  LAG(total) OVER (ORDER BY period) AS prev_period_total,
  ROUND(
    (total - LAG(total) OVER (ORDER BY period))
    / NULLIF(LAG(total) OVER (ORDER BY period), 0) * 100,
    2
  ) AS change_rate_pct,
  record_count
FROM period_agg
ORDER BY period;

-- 趋势判断逻辑（Agent 根据结果判断）：
-- 连续 3 期 change_rate_pct > 0   → "上升趋势"
-- 连续 3 期 change_rate_pct < 0   → "下降趋势"
-- 正负交替                      → "波动趋势"
-- |change_rate_pct| < 5%        → "基本平稳"
--
-- 注意：需要至少 4 个数据点才能计算 3 个 change_rate
