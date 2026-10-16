#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
"""把已关闭的变更整夹从 docs/intent/active/ 搬到 done/，并改写指向它的入向链接。

用法:
  python3 -I <技能目录>/scripts/aisdlc_archive.py <id> [--docs docs] [--dry-run]

前提: <id>/intent.md 的 Status 是 closed。active/ 与 done/ 同深度，所以夹内的出向链接不需要改。
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote

LINK_RE = re.compile(r"\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
EXTERNAL = ("http://", "https://", "mailto:", "tel:", "ftp://")


def mask_code(text: str) -> str:
    """把代码块和行内代码替换成等长空白，避免把里面的示例当成链接（位置保持不变）。"""
    blank = lambda m: re.sub(r"[^\n]", " ", m.group(0))
    text = re.sub(r"```.*?```", blank, text, flags=re.S)
    return re.sub(r"`[^`\n]+`", blank, text)


def local_links(text: str):
    """产出 (起, 止, 链接目标原文)，只含指向本仓库文件的链接。"""
    for m in LINK_RE.finditer(mask_code(text)):
        raw = m.group(1)
        if raw.startswith(EXTERNAL) or raw.startswith("#") or "://" in raw:
            continue
        yield m.start(1), m.end(1), raw


def status_of(intent: Path) -> str:
    for line in intent.read_text(encoding="utf-8").splitlines()[:20]:
        if m := re.match(r"Status:\s*(\w+)", line):
            return m.group(1).lower()
    return "?"


def rewrite_inbound(md: Path, src: Path, dst: Path) -> tuple[str, int]:
    """把 md 里指向 src 的链接改成指向 dst；返回 (新文本, 改写处数)。"""
    text = md.read_text(encoding="utf-8")
    out, last, n = [], 0, 0
    for start, end, raw in local_links(text):
        m = re.match(r"([^#?]*)(.*)", raw)
        path, suffix = m.group(1), m.group(2)
        if not path or path.startswith("/"):
            continue
        target = (md.parent / unquote(path)).resolve()
        if target != src and src not in target.parents:
            continue
        new_target = dst / target.relative_to(src)
        new_path = os.path.relpath(new_target, md.parent).replace(os.sep, "/")
        if path.endswith("/") and not new_path.endswith("/"):
            new_path += "/"
        out += [text[last:start], new_path + suffix]
        last, n = end, n + 1
    out.append(text[last:])
    return "".join(out), n


def broken_links(folder: Path) -> list[str]:
    bad = []
    for md in sorted(folder.rglob("*.md")):
        text = md.read_text(encoding="utf-8")
        for start, _, raw in local_links(text):
            path = re.match(r"[^#?]*", raw).group(0)
            if path and (path.startswith("/") or not (md.parent / unquote(path)).exists()):
                bad.append(f"{md.relative_to(folder.parent.parent.parent)}:{text.count(chr(10), 0, start) + 1}: {raw}")
    return bad


def move(src: Path, dst: Path) -> str:
    """优先 git mv（保留历史）；不在仓库里或文件未被跟踪时退回普通移动。"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["git", "mv", str(src), str(dst)], capture_output=True, text=True, cwd=src.parent)
    if r.returncode == 0:
        return "git mv"
    shutil.move(str(src), str(dst))
    return "移动"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("id", help="docs/intent/active/ 下的文件夹名，例如 261013-folder-merge")
    ap.add_argument("--docs", default="docs", help="docs 目录（默认 docs）")
    ap.add_argument("--dry-run", action="store_true", help="只打印将要做的事")
    args = ap.parse_args()

    docs = Path(args.docs).resolve()
    src = docs / "intent" / "active" / args.id
    dst = docs / "intent" / "done" / args.id
    if not src.is_dir():
        print(f"错误: 找不到 {src}", file=sys.stderr)
        return 1
    if dst.exists():
        print(f"错误: 目标已存在 {dst}", file=sys.stderr)
        return 1
    intent = src / "intent.md"
    if not intent.is_file():
        print(f"错误: {src} 里没有 intent.md", file=sys.stderr)
        return 1
    status = status_of(intent)
    if status != "closed":
        print(f"错误: Status 是 {status}，不是 closed。请先在评审通过后把 intent.md 的 Status 改为 closed。", file=sys.stderr)
        return 1

    # 入向链接：docs 下、搬走的夹之外的 md
    rewrites = []
    for md in sorted(docs.rglob("*.md")):
        if src in md.parents:
            continue
        new_text, n = rewrite_inbound(md, src, dst)
        if n:
            rewrites.append((md, new_text, n))

    rel = lambda p: p.relative_to(docs.parent)
    print(f"{'[dry-run] ' if args.dry_run else ''}搬迁: {rel(src)} -> {rel(dst)}")
    for md, _, n in rewrites:
        print(f"{'[dry-run] ' if args.dry_run else ''}改写入向链接: {rel(md)}（{n} 处）")
    if args.dry_run:
        return 0

    how = move(src, dst)
    for md, new_text, _ in rewrites:
        md.write_text(new_text, encoding="utf-8")
    print(f"已完成（{how}）；改写了 {sum(n for *_, n in rewrites)} 处入向链接，涉及 {len(rewrites)} 个文件")

    bad = broken_links(dst)
    for b in bad:
        print(f"✗ 搬迁后的出向链接失效: {b}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
