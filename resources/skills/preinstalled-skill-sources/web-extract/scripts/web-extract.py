#!/usr/bin/env python3
"""
web-extract Skill 脚本壳。

将命令行参数转发到 web-extract extension 的 Skill HTTP Server（127.0.0.1:20100）。
仅使用 Python 标准库，无第三方依赖。

用法：
    python web-extract.py --list                                      # 列出所有命令
    python web-extract.py --list --site bilibili                      # 按站点过滤
    python web-extract.py --site bilibili --command hot               # 执行命令
    python web-extract.py --site bilibili --command search --arg query=Python教程
    python web-extract.py --site bilibili --command hot --arg limit=10
    python web-extract.py --site bilibili --command search --arg query=Python教程 --arg limit=5
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import urllib.error
import urllib.request

# 强制子进程 stdout/stderr 使用 UTF-8
# run.py 以 capture_output=True 启动本脚本，子进程 stdout 是 pipe
# pipe 在 Windows 上默认编码为 GBK，必须在此强制切换为 UTF-8
# 否则 run.py decode("utf-8") 时会得到替换字符 \ufffd
if hasattr(sys.stdout, "buffer") and (not sys.stdout.encoding or sys.stdout.encoding.lower() != "utf-8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "buffer") and (not sys.stderr.encoding or sys.stderr.encoding.lower() != "utf-8"):
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

SKILL_SERVER_URL = "http://127.0.0.1:20100"
REQUEST_TIMEOUT = 120


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="通过 web-extract extension 访问 60+ 主流站点的结构化数据",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        default=False,
        help="列出所有已注册的适配器命令（不执行），可搭配 --site 按站点过滤",
    )
    parser.add_argument(
        "--site",
        default=None,
        help="目标站点名称，如 bilibili、zhihu、hackernews；执行命令时为必填",
    )
    parser.add_argument(
        "--command",
        default=None,
        help="命令名称，如 hot、search、top；list=false 时必填",
    )
    parser.add_argument(
        "--arg",
        action="append",
        dest="arg",
        default=[],
        metavar="KEY=VALUE",
        help="命令参数，key=value 形式，可重复使用，如 --arg query=Python教程 --arg limit=10",
    )
    parser.add_argument(
        "--args",
        default=None,
        help="命令参数（JSON 字符串，兼容旧用法），如 '{\"limit\":10}'；与 --arg 同时使用时 --arg 优先",
    )
    return parser.parse_args(argv)


def parse_kv_args(kv_list: list[str]) -> dict:
    """将 ['key=value', ...] 解析为 dict，值均保持字符串类型。
    类型转换（int/float/bool）由 Server 端 coerceAndValidateArgs 根据适配器声明统一处理。
    """
    result: dict = {}
    for item in kv_list:
        if "=" not in item:
            raise ValueError(f"--arg 参数格式错误，应为 key=value，实际收到：{item!r}")
        key, _, value = item.partition("=")
        result[key] = value
    return result


def call_server(path: str, payload: dict) -> dict | list:
    """向 Skill HTTP Server 发送 POST 请求，返回解析后的 JSON。"""
    url = f"{SKILL_SERVER_URL}{path}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except ConnectionRefusedError as exc:
        raise ConnectionError(f"无法连接到 web-extract extension（{url}）") from exc
    except urllib.error.URLError as exc:
        raise ConnectionError(f"无法连接到 web-extract extension（{url}）: {exc.reason}") from exc


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)

    if args.list:
        payload: dict = {}
        if args.site:
            payload["site"] = args.site
        path = "/list"
    else:
        if not args.site:
            print("错误：执行命令时 --site 为必填项", file=sys.stderr)
            sys.exit(1)
        if not args.command:
            print("错误：执行命令时 --command 为必填项", file=sys.stderr)
            sys.exit(1)

        extra_args: dict = {}

        # --arg key=value 优先；无 --arg 时回退到 --args JSON
        if args.arg:
            try:
                extra_args = parse_kv_args(args.arg)
            except ValueError as exc:
                print(f"错误：{exc}", file=sys.stderr)
                sys.exit(1)
        elif args.args is not None:
            try:
                extra_args = json.loads(args.args)
            except json.JSONDecodeError as exc:
                print(f"错误：--args JSON 解析失败: {exc}", file=sys.stderr)
                sys.exit(1)

        payload = {"site": args.site, "command": args.command, "args": extra_args}
        path = "/"

    try:
        result = call_server(path, payload)
    except ConnectionError as exc:
        print(
            f"错误：web-extract extension 未启动或不可达。\n"
            f"请确认 EasyClaw Gateway 已启动且 web-extract extension 已加载。\n"
            f"详情：{exc}",
            file=sys.stderr,
        )
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main()
