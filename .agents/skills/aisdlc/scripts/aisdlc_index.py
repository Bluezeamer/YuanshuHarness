#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
"""扫描 docs/intent 与 docs/lanes，生成 open / done 索引；--check 校验目录与 Status 一致、链接有效。

用法:
  python3 -I scripts/aisdlc/aisdlc_index.py [--docs docs] [--out INDEX.md] [--check]

不加 --check 也不加 --out：把索引打印到标准输出。
--check：发现问题以退出码 1 结束；同时给了 --out 则照常写出索引。
"""
import argparse
import os
import re
import sys
from pathlib import Path
from urllib.parse import unquote

LINK_RE = re.compile(r"\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
EXTERNAL = ("http://", "https://", "mailto:", "tel:", "ftp://")
ID_RE = re.compile(r"\d{6}-[a-z0-9][a-z0-9-]*")


def mask_code(text: str) -> str:
    """把代码块和行内代码替换成等长空白，避免把里面的示例当成链接（位置保持不变）。"""
    blank = lambda m: re.sub(r"[^\n]", " ", m.group(0))
    text = re.sub(r"```.*?```", blank, text, flags=re.S)
    return re.sub(r"`[^`\n]+`", blank, text)


def local_links(text: str):
    """产出 (在原文中的位置, 链接目标原文)，只含指向本仓库文件的链接。"""
    for m in LINK_RE.finditer(mask_code(text)):
        raw = m.group(1)
        if raw.startswith(EXTERNAL) or raw.startswith("#") or "://" in raw:
            continue
        yield m.start(1), raw


def header(md: Path) -> dict:
    """读 intent.md 头部的 Title / Status / Lane / Date（Status 只取第一个词）。"""
    info = {"title": md.parent.name, "status": "?", "lane": "-", "date": "-"}
    for line in md.read_text(encoding="utf-8").splitlines()[:20]:
        if line.startswith("# "):
            info["title"] = re.sub(r"^#\s*(Intent:\s*)?", "", line).strip()
        elif m := re.match(r"(Status|Lane|Date):\s*(.*)", line):
            key, value = m.group(1).lower(), m.group(2).strip()
            info[key] = re.split(r"[\s(（|]", value)[0].lower() if key == "status" else value
    return info


def scan_intents(docs: Path) -> dict[str, list[tuple[Path, dict]]]:
    found = {"active": [], "done": []}
    for kind in found:
        for d in sorted((docs / "intent" / kind).glob("*/")):
            md = d / "intent.md"
            found[kind].append((d, header(md) if md.is_file() else None))
    return found


def check(docs: Path, found) -> list[str]:
    problems = []
    for kind, items in found.items():
        for d, info in items:
            rel = d.relative_to(docs.parent)
            if info is None:
                problems.append(f"{rel}: 缺少 intent.md")
            elif kind == "active" and info["status"] == "closed":
                problems.append(f"{rel}: Status 已是 closed，应归档到 done/（aisdlc_archive.py {d.name}）")
            elif kind == "done" and info["status"] != "closed":
                problems.append(f"{rel}: 在 done/ 里但 Status 是 {info['status']}，应为 closed")
            if not ID_RE.fullmatch(d.name):
                print(f"提示: {rel} 不符合 <YYMMDD>-<kebab-slug> 命名，按名称排序将不是时间序", file=sys.stderr)
    for sub in ("intent/active", "intent/done", "lanes"):
        for md in sorted((docs / sub).rglob("*.md")):
            text = md.read_text(encoding="utf-8")
            for pos, raw in local_links(text):
                path = re.match(r"[^#?]*", raw).group(0)
                if not path:
                    continue
                line = text.count("\n", 0, pos) + 1
                where = f"{md.relative_to(docs.parent)}:{line}"
                if path.startswith("/"):
                    problems.append(f"{where}: 链接以 / 开头，请改用相对路径: {raw}")
                elif not (md.parent / unquote(path)).exists():
                    problems.append(f"{where}: 断链: {raw}")
    return problems


def render(docs: Path, found, base: Path) -> str:
    rel = lambda p: os.path.relpath(p, base).replace(os.sep, "/")
    out = ["# 变更索引", "", "> 由 `aisdlc_index.py` 自动生成，请勿手改。", ""]
    for kind, title in (("active", "进行中（active）"), ("done", "已关闭（done）")):
        out += [f"## {title}", "", "| 变更 | 档位 | 状态 | 日期 | 标题 |", "|---|---|---|---|---|"]
        for d, info in reversed(found[kind]) if kind == "done" else found[kind]:
            if info is None:
                out.append(f"| {d.name} | - | 缺少 intent.md | - | - |")
            else:
                link = f"[{d.name}]({rel(d / 'intent.md')})"
                out.append(f"| {link} | {info['lane']} | {info['status']} | {info['date']} | {info['title']} |")
        out.append("")
    lanes = sorted(p for p in (docs / "lanes").glob("*/") if p.is_dir())
    if lanes:
        out += ["## 快车道", "", "| 通道 | 章程 | 报告数 | 最近报告 |", "|---|---|---|---|"]
        for lane in lanes:
            charter = lane / "charter.md"
            status = "-"
            if charter.is_file():
                m = re.search(r"^Status:\s*(\w+)", charter.read_text(encoding="utf-8"), re.M)
                status = m.group(1) if m else "?"
            reports = sorted((lane / "reports").glob("*.md"))
            latest = f"[{reports[-1].name}]({rel(reports[-1])})" if reports else "-"
            out.append(f"| {lane.name} | {status} | {len(reports)} | {latest} |")
        out.append("")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--docs", default="docs", help="docs 目录（默认 docs）")
    ap.add_argument("--out", help="把索引写到该文件；不给则打印到标准输出（使用 --check 时不打印）")
    ap.add_argument("--check", action="store_true", help="校验目录与 Status 一致、链接有效")
    args = ap.parse_args()

    docs = Path(args.docs).resolve()
    if not docs.is_dir():
        print(f"错误: 找不到 docs 目录: {docs}", file=sys.stderr)
        return 2
    found = scan_intents(docs)

    code = 0
    if args.check:
        problems = check(docs, found)
        for p in problems:
            print(f"✗ {p}")
        print(f"校验{'未通过' if problems else '通过'}: active {len(found['active'])} 个, done {len(found['done'])} 个, 问题 {len(problems)} 处")
        code = 1 if problems else 0
    if args.out:
        out = Path(args.out).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(render(docs, found, out.parent), encoding="utf-8")
        print(f"已写出索引: {args.out}")
    elif not args.check:
        print(render(docs, found, Path.cwd()))
    return code


if __name__ == "__main__":
    sys.exit(main())
