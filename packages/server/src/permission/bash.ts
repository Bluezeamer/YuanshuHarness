// 命令只读判定与规范化（ADR-0030）。
// 本文件改写自 openai/codex（Apache-2.0）的
//   codex-rs/shell-command/src/command_safety/is_safe_command.rs
//   codex-rs/shell-command/src/bash.rs
// 取自提交 1b450c79126cc56df29b833110a8c702f82de882（Rust 译为 TypeScript）。
// 已修改：改用 web-tree-sitter 解析；不处理 `bash -lc` 包装与 Windows/PowerShell。
// git 只读清单收窄为 rev-parse/ls-files/branch（只读形态），status/diff/log/show/blame 已取消；
// 另追加更严的参数拒绝与若干额外命令，细节见各处注释。
// 许可证副本见 licenses/Apache-2.0.txt，来源说明见根目录 NOTICE。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Language, type Node, Parser } from "web-tree-sitter";
import { isInside, type PathEnv, pathOf, resolveTarget } from "./paths.js";

const require = createRequire(import.meta.url);

let parserReady: Promise<Parser> | undefined;
function getParser(): Promise<Parser> {
  parserReady ??= (async () => {
    await Parser.init();
    const wasm = readFileSync(
      require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"),
    );
    const p = new Parser();
    p.setLanguage(await Language.load(wasm));
    return p;
  })();
  return parserReady;
}

const CONNECTORS = new Set(["&&", "||", ";", "|"]);

/**
 * 把一个词节点还原为字面值；含展开/替换等一律返回 null。
 * strict（只读判定用）另拒绝 glob、花括号、`~`、`=` 开头等会被 shell 二次展开的词，
 * 与 Codex 的 is_literal_word_or_number 一致；非 strict 只拒反斜杠。
 */
function plainWord(n: Node, strict = false): string | null {
  if (n.type === "word" || n.type === "number") {
    if (n.text.includes("\\")) return null;
    if (strict && (n.text.startsWith("=") || /[{}*?[\]~^#$`]/.test(n.text)))
      return null;
    return n.text;
  }
  if (n.type === "raw_string") return n.text.slice(1, -1);
  if (n.type === "string") {
    // 只接受仅含 string_content 的双引号串（无 $、反引号等展开子节点）。
    if (n.namedChildren.some((c) => c.type !== "string_content")) return null;
    const inner = n.text.slice(1, -1);
    return /[$`\\]/.test(inner) ? null : inner;
  }
  if (n.type === "concatenation") {
    // 如 -g"*.py"：各段都是字面值才拼接（Codex 同样支持）。
    let out = "";
    for (const c of n.namedChildren) {
      const w = plainWord(c, strict);
      if (w === null) return null;
      out += w;
    }
    return out === "" ? null : out;
  }
  return null;
}

/** 解析为命令段（每段为词数组）与连接符；任何不确定构造返回 null。 */
function segments(
  n: Node,
  out: string[][],
  conns: string[],
  strict: boolean,
): boolean {
  switch (n.type) {
    case "program":
    case "list":
    case "pipeline":
      for (const c of n.children) {
        if (CONNECTORS.has(c.type)) conns.push(c.type);
        else if (!segments(c, out, conns, strict)) return false;
      }
      return true;
    case "command": {
      const words: string[] = [];
      for (const c of n.children) {
        if (c.type === "command_name") {
          const w = c.firstNamedChild
            ? plainWord(c.firstNamedChild, strict)
            : null;
          if (w === null) return false;
          words.push(w);
        } else {
          const w = plainWord(c, strict);
          if (w === null) return false;
          words.push(w);
        }
      }
      if (words.length === 0) return false;
      out.push(words);
      return true;
    }
    default:
      return false; // 重定向、子 shell、替换、后台符、换行串等
  }
}

async function parse(
  command: string,
  strict = false,
): Promise<{ segs: string[][]; conns: string[] } | null> {
  const text = command.trim();
  if (!text || text.includes("\n")) return null;
  const tree = (await getParser()).parse(text);
  if (!tree || tree.rootNode.hasError) return null;
  const segs: string[][] = [];
  const conns: string[] = [];
  return segments(tree.rootNode, segs, conns, strict) && segs.length > 0
    ? { segs, conns }
    : null;
}

/** 解析命令行为词数组的段列表；无法确定返回 null。 */
export async function parseCommand(
  command: string,
): Promise<string[][] | null> {
  return (await parse(command))?.segs ?? null;
}

const q = (w: string) =>
  /^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`;

/** 规范化命令行：词之间单空格、连接符前后单空格；无法解析返回 null。 */
export async function normalizeCommand(
  command: string,
): Promise<string | null> {
  const r = await parse(command);
  if (!r) return null;
  return r.segs
    .map((s, i) => `${i > 0 ? `${r.conns[i - 1]} ` : ""}${s.map(q).join(" ")}`)
    .join(" ");
}

// 无参数限制即只读的命令。
// Codex 清单：cat cd cut echo expr false grep head id ls nl paste pwd rev seq stat
// tail tr true uname uniq wc which whoami（numfmt、tac 仅 Linux）。
// 注：uniq 的第二个位置参数是输出文件，Codex 未拦截；本项目在 segmentSafe 里限制为至多一个位置参数。
const PLAIN_READONLY = new Set([
  "cat",
  "cd",
  "cut",
  "echo",
  "expr",
  "false",
  "grep",
  "head",
  "id",
  "ls",
  "nl",
  "paste",
  "pwd",
  "rev",
  "seq",
  "stat",
  "tail",
  "tr",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
  ...(process.platform === "linux" ? ["numfmt", "tac"] : []),
  // 以下为本项目额外加入、Codex 清单没有的只读命令：
  "date", // -s/--set 在下方单独拒绝
  "df",
  "du",
  "file",
  "sort", // -o/--output/--compress-program/-T/--temporary-directory 在下方单独拒绝
  "basename",
  "dirname",
  "realpath",
  "readlink",
]);

// Codex 旧版放行 status/log/diff/show/branch；其后 Codex 因仓库配置可触发外部程序
// （fsmonitor、外部 diff 等）移除了 git 放行。本项目收窄：取消 status/diff/log/show/blame，
// 只保留 rev-parse、ls-files 与 branch 的只读形态（ADR-0030）。
const GIT_READONLY = new Set(["rev-parse", "ls-files", "branch"]);
/**
 * git 下会写文件/执行外部程序的选项（Codex：--output --ext-diff --textconv --exec
 * 及 -c --exec-path 等全局项）。`--exec` 前缀同时覆盖 --exec-path；本项目更严：
 * 凡以 `-` 开头的全局项一律拒绝（见 segmentSafe），-c 在子命令后出现也拒绝。
 */
const GIT_BAD_OPT =
  /^(--output|--ext-diff|--textconv|--exec|-c$|--config|--open-files-in-pager|-O)/;
/** git branch 仅放行这些明确只读的选项（同 Codex），其余（-d/-m/-c/位置参数等）视为会改分支。 */
const GIT_BRANCH_READ_FLAGS = new Set([
  "--list",
  "-l",
  "--show-current",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
]);
const FIND_BAD = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);
// Codex：--pre --hostname-bin（含 =值 形式）、--search-zip、-z。
// 本项目更严：前缀匹配（连 --pre-glob 也拒），并拒绝含 z 的短选项合并如 -nz。
const RG_BAD = /^(--pre|--hostname-bin|--search-zip|-z$|-[a-zA-Z]*z)/;

const SORT_BAD_LONG = [
  "--output",
  "--compress-program",
  "--temporary-directory",
];
/** a 是否为长选项 full 的（缩写）写法，含 `=值`；至少两个字母才算缩写。 */
const isLongAbbrev = (a: string, full: string) => {
  const name = a.split("=")[0] ?? "";
  return name.length >= 3 && full.startsWith(name);
};

/** 单段是否只读（含对高风险参数的拒绝）。 */
function segmentSafe(w: string[]): boolean {
  const [cmd, ...args] = w as [string, ...string[]];
  if (cmd === "base64") {
    // 同 Codex：-o / --output / --output=… / -oFILE 会写文件
    return !args.some(
      (a) => a === "-o" || a.startsWith("--output") || a.startsWith("-o"),
    );
  }
  if (PLAIN_READONLY.has(cmd)) {
    // GNU 长选项允许唯一前缀缩写（--temp=…、--out=…），按前缀判；-T 会在指定目录建临时文件
    if (
      cmd === "sort" &&
      args.some(
        (a) =>
          /^-[a-zA-Z]*[oT]/.test(a) ||
          SORT_BAD_LONG.some((l) => isLongAbbrev(a, l)),
      )
    )
      return false;
    // date -s / --set 会改系统时间
    if (
      cmd === "date" &&
      args.some(
        (a) =>
          a === "--set" || a.startsWith("--set=") || /^-[a-zA-Z]*s/.test(a),
      )
    )
      return false;
    // uniq INPUT [OUTPUT]：第二个位置参数会写文件
    if (cmd === "uniq" && args.filter((a) => !a.startsWith("-")).length > 1)
      return false;
    return true;
  }
  if (cmd === "git") {
    const sub = args.find((a) => !a.startsWith("-"));
    if (args[0]?.startsWith("-") || !sub || !GIT_READONLY.has(sub))
      return false;
    if (args.some((a) => GIT_BAD_OPT.test(a))) return false;
    if (sub === "branch") {
      // 同 Codex：只认明确只读的选项（或 --format=…），且至少一个；无参数即列分支
      const rest = args.slice(1);
      return (
        rest.length === 0 ||
        rest.every(
          (a) => GIT_BRANCH_READ_FLAGS.has(a) || a.startsWith("--format="),
        )
      );
    }
    return true;
  }
  if (cmd === "find") return !args.some((a) => FIND_BAD.has(a));
  if (cmd === "rg") return !args.some((a) => RG_BAD.test(a));
  if (cmd === "sed")
    return (
      args.length >= 1 &&
      args[0] === "-n" &&
      /^\d+(,\d+)?p$/.test(args[1] ?? "") &&
      args.length <= 3
    );
  return false;
}

/** 整条命令是否为只读白名单的纯词连接。 */
export async function isReadOnlyCommand(command: string): Promise<boolean> {
  // 只读判定用 strict：额外拒绝 glob/花括号/~ 等会被 shell 二次展开的词。
  const segs = (await parse(command, true))?.segs;
  return !!segs && segs.every(segmentSafe);
}

/** 首词按 basename 归一化：/usr/bin/sudo 与 sudo 等价。 */
const baseName = (w: string) => w.split("/").pop() ?? "";
/** 词是否为 sudo（含绝对路径写法）。 */
export const isSudoWord = (w: string) => baseName(w) === "sudo";

const NO_REMEMBER_FIRST = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "env",
  "sudo",
  "su",
  "doas",
  "eval",
  "exec",
  "xargs",
  "nohup",
]);

/** 命令能否被记住：可解析、每段首词不在黑名单、不含 sudo。 */
export async function rememberable(command: string): Promise<boolean> {
  const segs = await parseCommand(command);
  if (!segs) return false;
  return segs.every(
    (s) => !NO_REMEMBER_FIRST.has(baseName(s[0] ?? "")) && !s.some(isSudoWord),
  );
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const isWrapper = (w: string) => SHELLS.has(w) || w === "eval";
/** 宽松切词（解析失败或词内含空白时用），保留 glob 与路径字符。 */
const looseTokens = (s: string) => s.split(/[\s'"`;|&<>()=$]+/).filter(Boolean);

export interface CommandAnalysis {
  /** 用于敏感词检测的所有词（含 shell 包装内的子命令）。 */
  words: string[];
  /** 存在无法分析的 shell 包装：只交人工、不可记住。 */
  opaque: boolean;
}

/**
 * 分析命令里的词：解析失败退回宽松切词；`bash/sh/zsh/dash/ksh -c '…'` 与 `eval`
 * 递归解析一层，包装内无法解析、嵌套包装、非 -c 形式（脚本文件/stdin）记为 opaque。
 */
export async function analyzeCommand(
  command: string,
  depth = 0,
): Promise<CommandAnalysis> {
  const segs = await parseCommand(command);
  if (!segs) {
    const toks = looseTokens(command);
    return {
      words: withOptionValues(toks),
      opaque: toks.some((t) => isWrapper(baseName(t))),
    };
  }
  // 含空白的词（如 env bash -c 'cat .env' 的脚本串）也拆开检测
  const words = segs
    .flat()
    .flatMap((w) => [w, ...(/\s/.test(w) ? looseTokens(w) : [])]);
  let opaque = false;
  for (const seg of segs) {
    const [first = "", ...args] = seg;
    const cmd = baseName(first);
    if (!isWrapper(cmd)) continue;
    let script: string | undefined;
    if (cmd === "eval") script = args.join(" ");
    else {
      const i = args.findIndex((a) => !a.startsWith("-"));
      if (i >= 0 && args.slice(0, i).some((a) => /^-[a-zA-Z]*c/.test(a)))
        script = args[i];
    }
    if (script === undefined) {
      opaque = true;
      continue;
    }
    if (depth >= 1 || (await parseCommand(script)) === null) opaque = true;
    if (depth >= 1) words.push(...looseTokens(script));
    else {
      const sub = await analyzeCommand(script, depth + 1);
      words.push(...sub.words);
      if (sub.opaque) opaque = true;
    }
  }
  return { words: withOptionValues(words), opaque };
}

/**
 * 补上选项附带的值，供敏感检查：`--file=.env` → `.env`；短选项 `-f.env`、`-nf.env` 无法可靠
 * 判断选项在哪结束，取每个后缀；值里的 `,` `:` 分隔项也拆开。凡含 `=` 的词一律取等号后部分。
 */
function withOptionValues(words: string[]): string[] {
  const extra: string[] = [];
  for (const w of words) {
    const eq = w.indexOf("=");
    if (eq >= 0) extra.push(w.slice(eq + 1));
    if (/^-[^-]/.test(w))
      for (let i = 2; i < w.length; i++) extra.push(w.slice(i));
  }
  const split = extra.flatMap((x) => [x, ...x.split(/[,:]/)]);
  return [...words, ...split.filter(Boolean)];
}

/**
 * 只读命令的路径操作数是否都落在 cwd 内：每个非选项词按相对 cwd 解析（含符号链接），
 * 出界或无法解析即 false；含 `/` 的选项词（如 `--files0-from=/x`）无法拆出路径，同样 false。
 * 保守：`grep /etc x` 这类疑似路径的词也会因出界而不放行。
 */
export async function operandsInside(
  command: string,
  cwd: string,
  env: PathEnv,
): Promise<boolean> {
  const segs = await parseCommand(command);
  if (!segs) return false;
  const pm = pathOf(env);
  for (const [, ...args] of segs) {
    for (const a of args) {
      // 递归并跟随符号链接的选项会越出 cwd
      if (/^-[^-]*R/.test(a) || a === "--dereference-recursive") return false;
      if (a === "-L" || a === "-follow" || a === "--dereference") return false;
      if (a.startsWith("-")) {
        if (a.includes("/")) return false;
        continue;
      }
      const p = await resolveTarget(a, cwd, env);
      if (p === null || !isInside(cwd, p, pm)) return false;
    }
  }
  return true;
}
