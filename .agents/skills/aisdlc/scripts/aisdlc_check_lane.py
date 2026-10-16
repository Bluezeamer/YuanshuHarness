#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
"""对照主干上的章程，检查分支的改动范围是否仍在快车道内。

用法:
  python3 -I scripts/aisdlc/aisdlc_check_lane.py docs/lanes/<lane>/charter.md --base origin/main [--head HEAD] [--report]

章程从 --base 上读取（不读分支自己的版本），所以 MR 无法先改宽白名单再放行自己。
退出码: 0 通过; 1 越线; 2 章程缺失/未批准/格式错误。
"""
import argparse
import re
import subprocess
import sys
import tomllib
from pathlib import Path


def git(*args: str, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], capture_output=True, text=True, cwd=cwd, check=check)


def glob_to_regex(pat: str) -> re.Pattern:
    """`**` 可跨目录，`*` 不跨 `/`，`?` 匹配单个非 `/` 字符；以 `/` 结尾视为整个目录。"""
    if pat.endswith("/"):
        pat += "**"
    out, i = [], 0
    while i < len(pat):
        if pat.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pat.startswith("**", i):
            out.append(".*")
            i += 2
        elif pat[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pat[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pat[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def load_charter(text: str, lane_dir: str) -> dict:
    """解析章程；任何问题抛 ValueError（由调用方转成退出码 2）。"""
    m = re.search(r"^Status:\s*(\w+)", text, re.M)
    if not m or m.group(1) != "approved":
        raise ValueError(f"章程 Status 不是 approved（现为 {m.group(1) if m else '缺失'}）：请先批准并合入主干")
    block = re.search(r"```toml\s*\n(.*?)```", text, re.S)
    if not block:
        raise ValueError("章程里没有 toml 代码块")
    try:
        cfg = tomllib.loads(block.group(1))
    except tomllib.TOMLDecodeError as e:
        raise ValueError(f"章程的 toml 块无法解析: {e}") from e
    if cfg.get("lane") != lane_dir:
        raise ValueError(f"章程里 lane = {cfg.get('lane')!r} 与目录名 {lane_dir!r} 不一致")
    for key in ("allow", "deny", "checks"):
        cfg.setdefault(key, [])
        if not isinstance(cfg[key], list) or not all(isinstance(x, str) for x in cfg[key]):
            raise ValueError(f"章程的 {key} 必须是字符串数组")
    if not cfg["allow"]:
        raise ValueError("章程的 allow 不能为空")
    for key in ("max_files", "max_lines"):
        if not isinstance(cfg.get(key), int) or cfg[key] <= 0:
            raise ValueError(f"章程的 {key} 必须是正整数")
    return cfg


def changed_files(base: str, head: str, cwd: Path) -> list[tuple[str, int]]:
    """返回 [(路径, 改动行数)]；重命名按“删旧 + 增新”各算一条，二进制文件行数记 0。"""
    raw = git("diff", "--numstat", "--no-renames", "-z", f"{base}...{head}", cwd=cwd).stdout
    files = []
    for rec in filter(None, raw.split("\0")):
        added, deleted, path = rec.split("\t", 2)
        files.append((path, 0 if added == "-" else int(added) + int(deleted)))
    return files


def split_own_reports(cfg: dict, files: list[tuple[str, int]]) -> tuple[list[tuple[str, int]], list[str]]:
    """本通道自己的 reports/ 目录是流程要求提交的产物，自动放行，也不计入体量上限。"""
    prefix = f"docs/lanes/{cfg['lane']}/reports/"
    return [f for f in files if not f[0].startswith(prefix)], [f[0] for f in files if f[0].startswith(prefix)]


def violations(cfg: dict, charter_path: str, files: list[tuple[str, int]]) -> list[str]:
    allow = [glob_to_regex(p) for p in cfg["allow"]]
    deny = [(p, glob_to_regex(p)) for p in cfg["deny"]]
    out = []
    for path, _ in files:
        if path == charter_path:
            out.append(f"{path}: 章程本身不属于任何通道，改章程须走正规流程")
        elif hit := next((p for p, rx in deny if rx.match(path)), None):
            out.append(f"{path}: 命中 deny（{hit}）")
        elif not any(rx.match(path) for rx in allow):
            out.append(f"{path}: 不在 allow 范围内")
    lines = sum(n for _, n in files)
    if len(files) > cfg["max_files"]:
        out.append(f"文件数 {len(files)} 超过上限 {cfg['max_files']}")
    if lines > cfg["max_lines"]:
        out.append(f"改动行数 {lines} 超过上限 {cfg['max_lines']}")
    return out


def report(cfg: dict, base: str, head: str, bad: list[str], cwd: Path) -> str:
    log = git("log", "--oneline", f"{base}..{head}", cwd=cwd).stdout.rstrip()
    stat = git("diff", "--stat", f"{base}...{head}", cwd=cwd).stdout.rstrip()
    result = f"未通过（{len(bad)} 条）" if bad else "通过"
    checks = "、".join(f"`{c}`" for c in cfg["checks"]) or "无"
    return "\n".join([
        "## 机械层（脚本生成，不经模型）",
        f"- 范围：`{base}..{head}`",
        f"- commits：\n```\n{log or '(无)'}\n```",
        f"- 文件分布：\n```\n{stat or '(无)'}\n```",
        f"- 章程越线检查：{result}",
        f"- 必过检查（章程 checks，由 CI 执行）：{checks}",
    ])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("charter", help="章程路径，例如 docs/lanes/ui-tuning/charter.md")
    ap.add_argument("--base", required=True, help="主干引用，例如 origin/main（章程和 diff 起点都取自这里）")
    ap.add_argument("--head", default="HEAD", help="分支引用（默认 HEAD）")
    ap.add_argument("--report", action="store_true", help="额外输出汇总报告的机械层")
    args = ap.parse_args()

    try:
        root = Path(git("rev-parse", "--show-toplevel").stdout.strip())
        charter_rel = Path(args.charter).resolve().relative_to(root).as_posix()
        shown = git("show", f"{args.base}:{charter_rel}", cwd=root, check=False)
        if shown.returncode != 0:
            raise ValueError(f"{args.base} 上没有 {charter_rel}：章程需要先合入主干")
        cfg = load_charter(shown.stdout, Path(charter_rel).parent.name)
        files = changed_files(args.base, args.head, root)
    except (ValueError, subprocess.CalledProcessError) as e:
        detail = e.stderr.strip() if isinstance(e, subprocess.CalledProcessError) else e
        print(f"错误: {detail}", file=sys.stderr)
        return 2

    files, own_reports = split_own_reports(cfg, files)
    bad = violations(cfg, charter_rel, files)
    lines = sum(n for _, n in files)
    if bad:
        print(f"✗ 快车道 {cfg['lane']} 越线 {len(bad)} 条：")
        for b in bad:
            print(f"  - {b}")
        print("→ 停下，把这部分改动升级为正规 intent（标准档或决策档）；已做的 commit 保留。")
    else:
        extra = f"（另有 {len(own_reports)} 个本通道报告文件，自动放行）" if own_reports else ""
        print(f"✓ 快车道 {cfg['lane']}：{len(files)} 个文件、{lines} 行改动，均在章程范围内{extra}")
    if args.report:
        print()
        print(report(cfg, args.base, args.head, bad, root))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
