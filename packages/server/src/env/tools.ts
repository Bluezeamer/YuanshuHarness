// 工具按会话当前 workspace 的环境路由（ADR-0034）：同名覆盖 SDK 的 7 个内置工具。
import path from "node:path";
import {
  type BashOperations,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLocalBashOperations,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DEFAULT_MAX_BYTES,
  type ExtensionFactory,
  formatSize,
  type GrepToolInput,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import { Masker, maskBashOperations } from "../permission/masking.js";
import { ENV_PREFIX, substitute } from "../permission/placeholders.js";
import { shq } from "./ssh.js";
import type { ExecEnv } from "./types.js";

export interface Where {
  env: ExecEnv;
  cwd: string;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const GREP_DEFAULT_LIMIT = 100;
const GREP_TIMEOUT_S = 60;
// 远程输出累计上限：防止超长行把 Server 内存撑爆。
const GREP_OUTPUT_CAP = 4 * 1024 * 1024;

const missing = (p: string) =>
  Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), {
    code: "ENOENT",
  });

async function accessible(env: ExecEnv, p: string): Promise<void> {
  if ((await env.stat(p)) === null) throw missing(p);
}

/** ssh 环境里 `~` 指远程 home；SDK 工具自己会按 Server 本机展开，所以这里先展开。 */
async function expandHome(env: ExecEnv, raw: string): Promise<string> {
  const p = raw.startsWith("@") ? raw.slice(1) : raw;
  if (p === "~" || p.startsWith("~/"))
    return path.posix.join(await env.homedir(), p.slice(1));
  return raw;
}

async function remoteParams(env: ExecEnv, params: unknown): Promise<unknown> {
  const p = params as { path?: unknown };
  if (typeof p?.path !== "string") return params;
  return { ...p, path: await expandHome(env, p.path) };
}

export function sshBashOperations(env: ExecEnv): BashOperations {
  return {
    // SDK 传来的 env 是 Server 本机的环境变量，不能带去远程；只转发隐私变量的那几个。
    exec: async (command, cwd, o) => {
      const vars = Object.entries(o.env ?? {}).filter(
        (e): e is [string, string] =>
          e[0].startsWith(ENV_PREFIX) && typeof e[1] === "string",
      );
      const r = await env.exec(command, cwd, {
        onData: o.onData,
        ...(vars.length ? { env: Object.fromEntries(vars) } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
        ...(o.timeout ? { timeout: o.timeout } : {}),
      });
      return { exitCode: r.exitCode };
    },
  };
}

/** fd 优先（含 Debian 的 fdfind），都没有退回 find。 */
export function globScript(
  pattern: string,
  dir: string,
  limit: number,
): string {
  const full = pattern.includes("/");
  const fdPattern =
    full &&
    !pattern.startsWith("/") &&
    !pattern.startsWith("**/") &&
    pattern !== "**"
      ? `**/${pattern}`
      : pattern;
  const findTest = full
    ? `-path ${shq(`*/${pattern.replace(/^(\*\*\/)+/, "")}`)}`
    : `-name ${shq(pattern)}`;
  return [
    "{",
    "FD=$(command -v fd || command -v fdfind || true)",
    'if [ -n "$FD" ]; then',
    `"$FD" --glob --color=never --hidden --no-require-git -E node_modules -E .git --max-results ${limit}${full ? " --full-path" : ""} -- ${shq(fdPattern)} ${shq(dir)}`,
    "else",
    `find ${shq(dir)} \\( -name node_modules -o -name .git \\) -prune -o ${findTest} -print | head -n ${limit}`,
    "fi",
    "} 2>/dev/null",
  ].join("\n");
}

async function runCollect(
  env: ExecEnv,
  script: string,
  cwd: string,
  opts: { signal?: AbortSignal; timeout?: number; cap?: number },
): Promise<{ text: string; exitCode: number; capped: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let capped = false;
  const cap = opts.cap ?? Number.POSITIVE_INFINITY;
  const r = await env.exec(script, cwd, {
    onData: (d) => {
      if (size >= cap) {
        capped = true;
        return;
      }
      chunks.push(d);
      size += d.length;
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
  });
  return { text: Buffer.concat(chunks).toString("utf8"), ...r, capped };
}

/** `rg --null` / `grep -Z` 的输出行：`路径\0行号:内容`。 */
const MATCH_LINE = /^([^\0]+)\0(\d+):(.*)$/s;

export function grepScript(
  input: GrepToolInput,
  searchPath: string,
  limit: number,
): string {
  const rg = [
    // 与扫描器（findSensitiveBelow）及 grep 回退一致，一律不进 node_modules（评审 M1#4）。
    "rg --null --no-heading --line-number --with-filename --color=never --hidden -g '!.git' -g '!node_modules'",
    input.ignoreCase ? "--ignore-case" : "",
    input.literal ? "--fixed-strings" : "",
    input.glob ? `--glob ${shq(input.glob)}` : "",
    `-e ${shq(input.pattern)} -- ${shq(searchPath)}`,
  ]
    .filter(Boolean)
    .join(" ");
  const grep = [
    "grep -rnHZI --exclude-dir=.git --exclude-dir=node_modules",
    input.ignoreCase ? "-i" : "",
    input.literal ? "-F" : "-E",
    input.glob ? `--include=${shq(input.glob)}` : "",
    `-e ${shq(input.pattern)} -- ${shq(searchPath)}`,
  ]
    .filter(Boolean)
    .join(" ");
  return [
    "{",
    "if command -v rg >/dev/null 2>&1; then",
    rg,
    "else",
    grep,
    "fi",
    `} | head -n ${limit + 1}`,
  ].join("\n");
}

async function sshGrep(
  env: ExecEnv,
  cwd: string,
  input: GrepToolInput,
  signal: AbortSignal | undefined,
) {
  const search = path.posix.resolve(cwd, input.path ?? ".");
  const st = await env.stat(search);
  if (!st) throw new Error(`Path not found: ${search}`);
  const limit = Math.max(1, input.limit ?? GREP_DEFAULT_LIMIT);
  const out = await runCollect(env, grepScript(input, search, limit), cwd, {
    ...(signal ? { signal } : {}),
    timeout: GREP_TIMEOUT_S,
    cap: GREP_OUTPUT_CAP,
  });
  const matches: { file: string; line: number; text: string }[] = [];
  const diagnostics: string[] = [];
  for (const raw of out.text.split("\n")) {
    if (raw === "") continue;
    const m = MATCH_LINE.exec(raw);
    if (m)
      matches.push({
        file: m[1] as string,
        line: Number(m[2]),
        text: m[3] as string,
      });
    else diagnostics.push(raw);
  }
  if (matches.length === 0) {
    // rg/grep 退出码 1 才是“没有匹配”；其余（坏的正则等）如实报错。
    if (out.exitCode > 1 && diagnostics.length > 0)
      throw new Error(diagnostics.join("\n").slice(0, 2000));
    return {
      content: [{ type: "text" as const, text: "No matches found" }],
      details: undefined,
    };
  }
  const limitReached = matches.length > limit;
  const shown = matches.slice(0, limit);
  const rel = (f: string) => {
    if (st.isDirectory) {
      const r = path.posix.relative(search, f);
      if (r && !r.startsWith("..")) return r;
    }
    return path.posix.basename(f);
  };
  const context = input.context && input.context > 0 ? input.context : 0;
  const fileLines = new Map<string, string[]>();
  const linesOf = async (f: string) => {
    let l = fileLines.get(f);
    if (!l) {
      try {
        l = (await env.readFile(f))
          .toString("utf8")
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .split("\n");
      } catch {
        l = [];
      }
      fileLines.set(f, l);
    }
    return l;
  };
  let linesTruncated = false;
  const clip = (t: string) => {
    const r = truncateLine(t.replace(/\r/g, ""));
    if (r.wasTruncated) linesTruncated = true;
    return r.text;
  };
  const rows: string[] = [];
  for (const m of shown) {
    if (context === 0) {
      rows.push(`${rel(m.file)}:${m.line}: ${clip(m.text)}`);
      continue;
    }
    const lines = await linesOf(m.file);
    if (!lines.length) {
      rows.push(`${rel(m.file)}:${m.line}: (unable to read file)`);
      continue;
    }
    const from = Math.max(1, m.line - context);
    const to = Math.min(lines.length, m.line + context);
    for (let n = from; n <= to; n++)
      rows.push(
        n === m.line
          ? `${rel(m.file)}:${n}: ${clip(lines[n - 1] ?? "")}`
          : `${rel(m.file)}-${n}- ${clip(lines[n - 1] ?? "")}`,
      );
  }
  const truncation = truncateHead(rows.join("\n"), {
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  const notices: string[] = [];
  const details: Record<string, unknown> = {};
  if (limitReached) {
    notices.push(
      `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`,
    );
    details.matchLimitReached = limit;
  }
  if (truncation.truncated || out.capped) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    if (truncation.truncated) details.truncation = truncation;
  }
  if (linesTruncated) {
    notices.push("Some lines truncated. Use read tool to see full lines");
    details.linesTruncated = true;
  }
  const text = notices.length
    ? `${truncation.content}\n\n[${notices.join(". ")}]`
    : truncation.content;
  return {
    content: [{ type: "text" as const, text }],
    details: Object.keys(details).length ? details : undefined,
  };
}

// 工具定义的泛型参数各不相同，这里只关心 execute 的转发。
type AnyDef = ReturnType<typeof createReadToolDefinition> & {
  execute: (...a: never[]) => Promise<unknown>;
};

/**
 * 注册 7 个同名工具。每次调用取会话当前 workspace 的环境：
 * 本机不传 operations，行为与 SDK 原样一致；ssh 经环境原语走远程。
 */
export function routedToolsExtension(
  where: () => Where,
  // 隐私变量的真值（名字 → 值）；bash 启动进程前才替换占位符，见 ADR-0051。
  variables?: () => ReadonlyMap<string, string>,
): ExtensionFactory {
  return (pi) => {
    const route = (
      make: (cwd: string, options?: object) => unknown,
      remote: (env: ExecEnv) => unknown,
      prepare?: (
        params: unknown,
      ) => Promise<{ params: unknown; env: Record<string, string> } | null>,
      // 包一层 operations（本机时入参为 undefined）；bash 用它做流式输出遮罩。
      wrap?: (ops: unknown) => unknown,
    ) => {
      const proto = make(process.cwd()) as AnyDef;
      pi.registerTool({
        ...proto,
        async execute(
          id: string,
          params: unknown,
          signal: unknown,
          onUpdate: unknown,
          ctx: object,
        ) {
          const { env, cwd } = where();
          // SDK 工具优先用 ctx.cwd；会话中途切换 workspace 后它仍是启动时的目录，必须覆盖。
          const c = Object.create(ctx ?? null, {
            cwd: { value: cwd, enumerable: true },
          });
          const local = env.kind === "local";
          const sub = await prepare?.(params);
          const base = local ? undefined : remote(env);
          const ops = wrap?.(base) ?? base;
          const def = make(cwd, {
            ...(ops ? { operations: ops } : {}),
            // 只对这一次调用生效：值进这条命令的进程环境，不进会话环境。
            ...(sub?.env && Object.keys(sub.env).length
              ? {
                  spawnHook: (c: { env: NodeJS.ProcessEnv }) => ({
                    ...c,
                    env: { ...c.env, ...sub.env },
                  }),
                }
              : {}),
          }) as { execute: (...a: unknown[]) => Promise<unknown> };
          const input = sub?.params ?? params;
          return def.execute(
            id,
            local ? input : await remoteParams(env, input),
            signal,
            onUpdate,
            c,
          );
        },
      } as never);
    };

    route(createReadToolDefinition as never, (env) => ({
      readFile: (p: string) => env.readFile(p),
      access: (p: string) => accessible(env, p),
      detectImageMimeType: async (p: string) =>
        IMAGE_MIME[path.posix.extname(p).toLowerCase()] ?? null,
    }));
    route(createWriteToolDefinition as never, (env) => ({
      writeFile: (p: string, c: string) => env.writeFile(p, c),
      mkdir: (d: string) => env.mkdirp(d),
    }));
    route(createEditToolDefinition as never, (env) => ({
      readFile: (p: string) => env.readFile(p),
      writeFile: (p: string, c: string) => env.writeFile(p, c),
      access: (p: string) => accessible(env, p),
    }));
    route(
      createBashToolDefinition as never,
      (env) => sshBashOperations(env),
      async (params) => {
        const p = params as { command?: unknown };
        const values = variables?.();
        if (!values?.size || typeof p?.command !== "string") return null;
        const r = await substitute(p.command, values);
        return { params: { ...p, command: r.command }, env: r.env };
      },
      // 输出里的真值换回占位符（ADR-0053）；每次调用取最新清单。
      (ops) => {
        const masker = new Masker(
          [...(variables?.() ?? [])].map(([name, value]) => ({ name, value })),
        );
        return masker.empty
          ? undefined
          : maskBashOperations(
              (ops as BashOperations | undefined) ??
                createLocalBashOperations(),
              masker,
            );
      },
    );
    route(createLsToolDefinition as never, (env) => ({
      exists: async (p: string) => (await env.stat(p)) !== null,
      stat: async (p: string) => {
        const s = await env.stat(p);
        if (!s) throw missing(p);
        return { isDirectory: () => s.isDirectory };
      },
      readdir: async (p: string) => (await env.readdir(p)).map((e) => e.name),
    }));
    route(createFindToolDefinition as never, (env) => ({
      exists: async (p: string) => (await env.stat(p)) !== null,
      glob: async (pattern: string, dir: string, o: { limit: number }) => {
        const r = await runCollect(
          env,
          globScript(pattern, dir, o.limit),
          dir,
          {
            timeout: GREP_TIMEOUT_S,
            cap: GREP_OUTPUT_CAP,
          },
        );
        return r.text
          .split("\n")
          .filter((l) => l !== "")
          .slice(0, o.limit);
      },
    }));

    // grep 的 SDK 实现固定本机起 rg，ssh 环境整体换成远程实现。
    const grepProto = createGrepToolDefinition(process.cwd());
    pi.registerTool({
      ...grepProto,
      async execute(
        id: string,
        params: GrepToolInput,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: object,
      ) {
        const { env, cwd } = where();
        if (env.kind === "local") {
          const c = Object.create(ctx ?? null, {
            cwd: { value: cwd, enumerable: true },
          });
          return (
            createGrepToolDefinition(cwd) as unknown as {
              execute: (...a: unknown[]) => Promise<unknown>;
            }
          ).execute(id, params, signal, onUpdate, c) as never;
        }
        const p = (await remoteParams(env, params)) as GrepToolInput;
        return sshGrep(env, cwd, p, signal);
      },
    } as never);
  };
}
