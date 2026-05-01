#!/usr/bin/env python3
"""
web-extract Skill 统一入口。

将所有命令行参数透传给 scripts/web-extract.py，并保证 stdout/stderr 以 UTF-8 输出。
使用 Path(__file__) 自动定位脚本路径，无需 cd 切换目录，macOS 和 Windows 行为完全相同。

用法（<skill_path> 替换为本文件所在目录）：
    python <skill_path>/run.py --list
    python <skill_path>/run.py --list --site bilibili
    python <skill_path>/run.py --site bilibili --command hot
    python <skill_path>/run.py --site bilibili --command search --args '{"query":"Python教程"}'
"""

from __future__ import annotations

import io
import subprocess
import sys
from pathlib import Path

# 强制父进程 stdout/stderr 使用 UTF-8
# 确保 exec 工具以文本模式捕获时也能正确解码，而非使用 GBK
if hasattr(sys.stdout, "buffer") and (not sys.stdout.encoding or sys.stdout.encoding.lower() != "utf-8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "buffer") and (not sys.stderr.encoding or sys.stderr.encoding.lower() != "utf-8"):
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# web-extract.py 与本文件的相对位置固定，不依赖 cwd
WEBCLI = Path(__file__).resolve().parent / "scripts" / "web-extract.py"


def main() -> None:
    cmd = [sys.executable, str(WEBCLI), *sys.argv[1:]]
    result = subprocess.run(
        cmd,
        capture_output=True,
    )

    # 子进程输出是 UTF-8 bytes，解码后交给已强制 UTF-8 的 sys.stdout 输出
    # 这样无论 exec 工具以何种方式捕获，拿到的都是正确的 Unicode 文本
    sys.stdout.write(result.stdout.decode("utf-8", errors="replace"))
    sys.stdout.flush()

    if result.stderr:
        sys.stderr.write(result.stderr.decode("utf-8", errors="replace"))
        sys.stderr.flush()

    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
