#!/usr/bin/env python3
"""
Pi Data Agent — 无状态图表生成脚本

用法:
    python3 generate_chart.py <config_json_path>

输入: JSON 配置文件路径，格式见 Pi 扩展规范
输出: 生成 PNG 到指定路径，stdout 输出 JSON 元数据
"""

import json
import sys
import os
import csv
from pathlib import Path

import matplotlib
matplotlib.use("Agg")  # 无头后端，必须在使用 pyplot 之前设置
import matplotlib.pyplot as plt
import seaborn as sns
import pandas as pd
import numpy as np

# ----------------------------------------------------------------------------
# 中文字体配置
# ----------------------------------------------------------------------------
# 按优先级尝试常见 CJK 字体，避免中文标签显示为方块
_CJK_FONTS = [
    "Noto Sans CJK SC",    # Linux 常见
    "PingFang SC",          # macOS
    "Microsoft YaHei",      # Windows
    "SimHei",               # Windows 备选
    "WenQuanYi Micro Hei",  # Linux 备选
    "Arial Unicode MS",     # macOS 备选
]
_available = set(f.name for f in matplotlib.font_manager.fontManager.ttflist)
for _font in _CJK_FONTS:
    if _font in _available:
        plt.rcParams["font.sans-serif"] = [_font, "DejaVu Sans"]
        plt.rcParams["axes.unicode_minus"] = False
        break
else:
    # 没找到 CJK 字体，用默认并警告
    import warnings
    warnings.warn("No CJK font found. Chinese labels may not render correctly.",
                  RuntimeWarning)


# ============================================================================
# 图表生成器
# ============================================================================

def read_csv_data(data_path: str) -> pd.DataFrame:
    """读取 CSV 数据"""
    df = pd.read_csv(data_path)
    return df


def get_figsize(options: dict) -> tuple:
    """从 options 获取图表尺寸"""
    figsize = options.get("figsize", [10, 6])
    return tuple(figsize)


def get_color(options: dict, default="steelblue"):
    """从 options 获取颜色"""
    return options.get("color", default)


def save_and_measure(fig, output_path: str) -> int:
    """保存图表并返回文件大小（字节）"""
    fig.tight_layout()
    fig.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    return os.path.getsize(output_path)


def chart_bar(df: pd.DataFrame, config: dict) -> dict:
    """柱状图"""
    x_col = config["xColumn"]
    y_col = config.get("yColumn")
    options = config.get("options", {})

    fig, ax = plt.subplots(figsize=get_figsize(options))

    if y_col:
        df.plot.bar(x=x_col, y=y_col, ax=ax, color=get_color(options), legend=False)
    else:
        # 如果只有 xColumn，统计频次
        counts = df[x_col].value_counts().sort_index()
        counts.plot.bar(ax=ax, color=get_color(options))

    ax.set_title(config.get("title", "Bar Chart"))
    ax.set_xlabel(config.get("xLabel", x_col))
    ax.set_ylabel(config.get("yLabel", y_col or "Count"))
    plt.setp(ax.xaxis.get_majorticklabels(), rotation=45, ha="right")

    file_size = save_and_measure(fig, config["outputPath"])
    return {"rowCount": len(df), "columns": [c for c in [x_col, y_col] if c], "fileSizeBytes": file_size}


def chart_line(df: pd.DataFrame, config: dict) -> dict:
    """折线图"""
    x_col = config["xColumn"]
    y_col = config.get("yColumn")
    options = config.get("options", {})

    fig, ax = plt.subplots(figsize=get_figsize(options))

    if y_col:
        df.plot.line(x=x_col, y=y_col, ax=ax, color=get_color(options), marker="o", legend=False)
    else:
        # 如果只有 xColumn，按 x 排序后画索引值
        df_sorted = df.sort_values(by=x_col)
        df_sorted.reset_index(drop=True).index.plot.line(ax=ax, color=get_color(options), marker="o")

    ax.set_title(config.get("title", "Line Chart"))
    ax.set_xlabel(config.get("xLabel", x_col))
    ax.set_ylabel(config.get("yLabel", y_col or "Value"))
    plt.setp(ax.xaxis.get_majorticklabels(), rotation=45, ha="right")

    file_size = save_and_measure(fig, config["outputPath"])
    return {"rowCount": len(df), "columns": [c for c in [x_col, y_col] if c], "fileSizeBytes": file_size}


def chart_scatter(df: pd.DataFrame, config: dict) -> dict:
    """散点图"""
    x_col = config["xColumn"]
    y_col = config["yColumn"]
    options = config.get("options", {})

    fig, ax = plt.subplots(figsize=get_figsize(options))

    color_col = options.get("colorColumn")
    if color_col and color_col in df.columns:
        # 分类着色
        categories = df[color_col].unique()
        # matplotlib >= 3.9 移除了 plt.cm.get_cmap，改用 colormap 注册表 API，旧版本回退
        try:
            cmap = plt.colormaps["tab10"].resampled(len(categories))
        except AttributeError:
            cmap = plt.cm.get_cmap("tab10", len(categories))
        for i, cat in enumerate(categories):
            subset = df[df[color_col] == cat]
            ax.scatter(subset[x_col], subset[y_col], label=str(cat), alpha=0.7)
        ax.legend(title=color_col)
    else:
        ax.scatter(df[x_col], df[y_col], alpha=0.7, color=get_color(options, "steelblue"))

    ax.set_title(config.get("title", "Scatter Plot"))
    ax.set_xlabel(config.get("xLabel", x_col))
    ax.set_ylabel(config.get("yLabel", y_col))

    file_size = save_and_measure(fig, config["outputPath"])
    return {"rowCount": len(df), "columns": [x_col, y_col], "fileSizeBytes": file_size}


def chart_histogram(df: pd.DataFrame, config: dict) -> dict:
    """直方图"""
    columns = config.get("columns", [config.get("xColumn")])
    columns = [c for c in columns if c and c in df.columns]
    if not columns:
        raise ValueError("No valid columns specified for histogram")

    options = config.get("options", {})
    bins = options.get("bins", 10)

    fig, ax = plt.subplots(figsize=get_figsize(options))

    for col in columns:
        ax.hist(df[col].dropna(), bins=bins, alpha=0.6, label=col)

    if len(columns) > 1:
        ax.legend()

    ax.set_title(config.get("title", "Histogram"))
    ax.set_xlabel(config.get("xLabel", ", ".join(columns)))
    ax.set_ylabel(config.get("yLabel", "Frequency"))

    file_size = save_and_measure(fig, config["outputPath"])
    return {"rowCount": len(df), "columns": columns, "fileSizeBytes": file_size}


def chart_pie(df: pd.DataFrame, config: dict) -> dict:
    """饼图"""
    x_col = config["xColumn"]
    y_col = config.get("yColumn")
    options = config.get("options", {})

    fig, ax = plt.subplots(figsize=get_figsize(options))

    if y_col:
        labels = df[x_col].astype(str)
        sizes = df[y_col]
    else:
        # 只给 xColumn，统计频次
        counts = df[x_col].value_counts()
        labels = counts.index.astype(str)
        sizes = counts.values

    ax.pie(sizes, labels=labels, autopct="%1.1f%%", startangle=90)
    ax.set_title(config.get("title", "Pie Chart"))

    file_size = save_and_measure(fig, config["outputPath"])
    return {"rowCount": len(df), "columns": [c for c in [x_col, y_col] if c], "fileSizeBytes": file_size}


def chart_box(df: pd.DataFrame, config: dict) -> dict:
    """箱线图"""
    columns = config.get("columns", [config.get("xColumn")])
    columns = [c for c in columns if c and c in df.columns]
    if not columns:
        raise ValueError("No valid columns specified for box plot")

    options = config.get("options", {})

    fig, ax = plt.subplots(figsize=get_figsize(options))

    df[columns].boxplot(ax=ax)
    ax.set_title(config.get("title", "Box Plot"))
    ax.set_ylabel(config.get("yLabel", "Value"))
    plt.setp(ax.xaxis.get_majorticklabels(), rotation=45, ha="right")

    file_size = save_and_measure(fig, config["outputPath"])
    return {"rowCount": len(df), "columns": columns, "fileSizeBytes": file_size}


def chart_heatmap(df: pd.DataFrame, config: dict) -> dict:
    """热力图（相关性矩阵）"""
    columns = config.get("columns", [config.get("xColumn"), config.get("yColumn")])
    columns = [c for c in columns if c and c in df.columns]
    if len(columns) < 2:
        # 如果指定列不足2个，自动选择所有数值列
        numeric_df = df.select_dtypes(include=[np.number])
        if numeric_df.shape[1] < 2:
            raise ValueError("Need at least 2 numeric columns for heatmap")
        columns = list(numeric_df.columns)
    else:
        numeric_df = df[columns].select_dtypes(include=[np.number])
        columns = list(numeric_df.columns)

    options = config.get("options", {})

    corr = numeric_df.corr()

    fig, ax = plt.subplots(figsize=get_figsize(options))
    sns.heatmap(corr, annot=True, cmap="coolwarm", center=0, ax=ax,
                fmt=".2f", square=True, linewidths=0.5)
    ax.set_title(config.get("title", "Correlation Heatmap"))

    file_size = save_and_measure(fig, config["outputPath"])
    return {"rowCount": len(df), "columns": columns, "fileSizeBytes": file_size}


# ============================================================================
# 主流程
# ============================================================================

CHART_HANDLERS = {
    "bar": chart_bar,
    "line": chart_line,
    "scatter": chart_scatter,
    "histogram": chart_histogram,
    "pie": chart_pie,
    "box": chart_box,
    "heatmap": chart_heatmap,
}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: generate_chart.py <config_json_path>"}))
        sys.exit(1)

    config_path = sys.argv[1]

    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Failed to read config: {e}"}))
        sys.exit(1)

    # 校验必填字段
    required = ["chartType", "dataPath", "outputPath"]
    missing = [f for f in required if f not in config]
    if missing:
        print(json.dumps({"success": False, "error": f"Missing required fields: {missing}"}))
        sys.exit(1)

    chart_type = config["chartType"]
    if chart_type not in CHART_HANDLERS:
        print(json.dumps({"success": False, "error": f"Unsupported chart type: {chart_type}. Supported: {list(CHART_HANDLERS.keys())}"}))
        sys.exit(1)

    data_path = config["dataPath"]
    if not os.path.exists(data_path):
        print(json.dumps({"success": False, "error": f"Data file not found: {data_path}"}))
        sys.exit(1)

    output_path = config["outputPath"]
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    try:
        df = read_csv_data(data_path)
        if len(df) == 0:
            print(json.dumps({"success": False, "error": "Data file is empty"}))
            sys.exit(1)

        result = CHART_HANDLERS[chart_type](df, config)

        output = {
            "success": True,
            "outputPath": output_path,
            "chartType": chart_type,
            **result,
        }
        print(json.dumps(output))
        sys.exit(0)

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
