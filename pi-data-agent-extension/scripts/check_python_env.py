#!/usr/bin/env python3
"""
Pi Data Agent — Python 环境检查脚本

检查项：
1. python3 版本 >= 3.9
2. pandas >= 2.0
3. matplotlib >= 3.8
4. seaborn >= 0.13
5. numpy >= 1.24
6. scipy >= 1.10（统计分析需要）

返回 JSON 格式结果，便于 Agent 解析。
"""

import json
import sys


def check() -> dict:
    result = {
        "python_version_ok": False,
        "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "dependencies": {},
        "all_ok": False,
        "install_suggestion": "pip install -r requirements.txt",
    }

    # Python 版本检查
    if sys.version_info >= (3, 9):
        result["python_version_ok"] = True

    deps = [
        ("pandas", "2.0"),
        ("matplotlib", "3.8"),
        ("seaborn", "0.13"),
        ("numpy", "1.24"),
        ("scipy", "1.10"),
    ]

    all_ok = result["python_version_ok"]
    missing = []

    for name, min_version in deps:
        try:
            mod = __import__(name)
            version = getattr(mod, "__version__", "unknown")
            # 简单版本比较（major.minor）
            parts = version.split(".")
            min_parts = min_version.split(".")
            ok = True
            for i in range(min(len(parts), len(min_parts))):
                try:
                    if int(parts[i]) < int(min_parts[i]):
                        ok = False
                        break
                    elif int(parts[i]) > int(min_parts[i]):
                        break
                except ValueError:
                    continue
            result["dependencies"][name] = {"installed": True, "version": version, "ok": ok}
            if not ok:
                all_ok = False
        except ImportError:
            result["dependencies"][name] = {"installed": False, "version": None, "ok": False}
            all_ok = False
            missing.append(name)

    result["all_ok"] = all_ok
    if missing:
        result["missing_dependencies"] = missing

    return result


if __name__ == "__main__":
    print(json.dumps(check(), ensure_ascii=False))
