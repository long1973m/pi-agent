#!/usr/bin/env python3
"""
生成 v0.3 真实业务样例 Eval 数据集

固定随机种子（seed=42），确保可复现、可控、无隐私风险。
输出到当前目录（src/eval/fixtures/）。

数据集：
- ecommerce_orders.csv    电商订单数据
- user_events.csv         用户行为事件
- sales_daily.csv         日销售流水
- insurance_policies.csv  保险保单/理赔
"""

import csv
import random
from datetime import datetime, timedelta

# 固定随机种子，确保可复现
random.seed(42)

OUTPUT_DIR = "."


def random_date(start: datetime, days: int) -> datetime:
    return start + timedelta(days=random.randint(0, days))


def generate_ecommerce_orders(n: int = 500) -> str:
    """电商订单数据"""
    path = f"{OUTPUT_DIR}/ecommerce_orders.csv"
    channels = ["app", "web", "mini_program", "offline"]
    statuses = ["completed", "cancelled", "refunded", "pending"]

    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["order_id", "user_id", "order_time", "channel", "amount", "is_new_user", "status"])

        base_time = datetime(2024, 6, 1, 0, 0, 0)
        for i in range(1, n + 1):
            user_id = random.randint(1000, 1099)
            order_time = random_date(base_time, 30)
            channel = random.choice(channels)
            # app 渠道金额偏高
            base_amount = 50 if channel == "app" else 30
            amount = round(random.gauss(base_amount, 20), 2)
            amount = max(5.0, amount)
            is_new = random.random() < 0.3
            status = random.choices(statuses, weights=[0.75, 0.1, 0.05, 0.1])[0]
            writer.writerow([
                f"ORD{i:06d}",
                f"USR{user_id:04d}",
                order_time.strftime("%Y-%m-%d %H:%M:%S"),
                channel,
                amount,
                "true" if is_new else "false",
                status,
            ])
    return path


def generate_user_events(n: int = 800) -> str:
    """用户行为事件数据"""
    path = f"{OUTPUT_DIR}/user_events.csv"
    event_types = ["page_view", "click", "add_cart", "purchase", "share", "search"]
    devices = ["iOS", "Android", "Web", "iPad"]
    cities = ["北京", "上海", "广州", "深圳", "杭州", "成都", "武汉", "西安"]

    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["event_id", "user_id", "event_time", "event_type", "device", "city"])

        base_time = datetime(2024, 6, 1, 0, 0, 0)
        for i in range(1, n + 1):
            user_id = random.randint(1000, 1099)
            event_time = random_date(base_time, 30)
            # page_view 和 click 占多数
            event_type = random.choices(
                event_types, weights=[0.35, 0.25, 0.15, 0.1, 0.08, 0.07]
            )[0]
            device = random.choice(devices)
            city = random.choice(cities)
            writer.writerow([
                f"EVT{i:07d}",
                f"USR{user_id:04d}",
                event_time.strftime("%Y-%m-%d %H:%M:%S"),
                event_type,
                device,
                city,
            ])
    return path


def generate_sales_daily(n: int = 90) -> str:
    """日销售流水数据（90 天）"""
    path = f"{OUTPUT_DIR}/sales_daily.csv"
    categories = ["electronics", "clothing", "food", "home", "sports"]
    store_ids = [f"S{i:03d}" for i in range(1, 11)]

    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["date", "store_id", "category", "sales_amount", "order_count"])

        base_date = datetime(2024, 6, 1)
        for day_offset in range(n):
            date = (base_date + timedelta(days=day_offset)).strftime("%Y-%m-%d")
            for store in store_ids:
                for cat in categories:
                    #  Electronics 销售额高，随机波动
                    base = 3000 if cat == "electronics" else 1500
                    # 加入趋势和周末效应
                    is_weekend = (base_date + timedelta(days=day_offset)).weekday() >= 5
                    weekend_boost = 1.3 if is_weekend else 1.0
                    # 第 60 天左右人为制造异常高销售额
                    anomaly_boost = 2.5 if day_offset == 60 else 1.0
                    sales = round(random.gauss(base, 500) * weekend_boost * anomaly_boost, 2)
                    sales = max(100.0, sales)
                    orders = max(1, int(sales / random.uniform(80, 150)))
                    writer.writerow([date, store, cat, sales, orders])
    return path


def generate_insurance_policies(n: int = 300) -> str:
    """保险保单/理赔模拟数据"""
    path = f"{OUTPUT_DIR}/insurance_policies.csv"
    product_types = ["life", "health", "auto", "property", "travel"]
    statuses = ["active", "expired", "claimed", "cancelled"]

    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "policy_id", "customer_id", "product_type", "premium",
            "claim_amount", "policy_status", "start_date",
        ])

        base_date = datetime(2023, 1, 1)
        for i in range(1, n + 1):
            customer_id = random.randint(2000, 2199)
            product = random.choice(product_types)
            # 不同产品保费范围不同
            premium_ranges = {
                "life": (2000, 8000),
                "health": (500, 3000),
                "auto": (1500, 5000),
                "property": (800, 2500),
                "travel": (100, 800),
            }
            pmin, pmax = premium_ranges[product]
            premium = round(random.uniform(pmin, pmax), 2)

            # 20% 的保单有理赔
            has_claim = random.random() < 0.2
            claim_amount = round(random.uniform(premium * 0.5, premium * 5), 2) if has_claim else 0.0

            status = random.choices(statuses, weights=[0.6, 0.15, 0.15, 0.1])[0]
            start_date = (base_date + timedelta(days=random.randint(0, 540))).strftime("%Y-%m-%d")

            writer.writerow([
                f"POL{i:06d}",
                f"CUST{customer_id:04d}",
                product,
                premium,
                claim_amount,
                status,
                start_date,
            ])
    return path


def main():
    files = [
        generate_ecommerce_orders(500),
        generate_user_events(800),
        generate_sales_daily(90),
        generate_insurance_policies(300),
    ]
    print("Generated fixtures:")
    for f in files:
        print(f"  - {f}")
    print("\nAll done. Use load_data to load these CSV files into DuckDB.")


if __name__ == "__main__":
    main()
