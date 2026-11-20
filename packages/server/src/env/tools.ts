// 工具按会话当前 directory 的环境路由（ADR-0034）：同名覆盖 SDK 的 7 个内置工具。
// 六个文件工具按 host 参数路由（`locate`，见 session/address.ts）：host 说在哪台机器（或哪个目录），path 只是路径；
// bash 的 host 只收 `<host>:<name>`（`locateDirectory`）：它是这条命令的工作目录，缺省仍是当前目录。
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
import { scanBashOperations } from "../browser/ports/bash.js";
import { Detached, jobBashOperations } from "../job/bash.js";
import type { JobManager } from "../job/manager.js";
import { Masker, maskBashOperations } from "../permission/masking.js";
import { ENV_PREFIX, substitute } from "../permission/placeholders.js";
import type { Located } from "../session/address.js";
import { hostProperty } from "../session/host-param.js";
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

/**
 * read 工具的前置围栏：gif 作为图片输入无法被模型解析，且会污染会话上下文，
 * 这里直接拒绝并提示改用 png/jpeg 或只查看文件信息。
 */
export function assertReadableFile(p: unknown): void {
  if (typeof p === "string" && p.toLowerCase().endsWith(".gif"))
    throw new Error(
      "不能直接 read gif：图片输入无法被模型解析，会把会话上下文弄坏。请改用 png/jpeg，或通过 bash/ls 查看文件信息。",
    );
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
 * 文件工具的声明：在 SDK 原来的 parameters 上加 host、改 path 的描述，
 * 其余部分（type、required、别的属性）原样保留。host 排在 path 之后，六个工具一致。
 */
function fileDeclaration(proto: AnyDef, pathDescription: string) {
  const base = proto.parameters as {
    properties?: Record<string, object>;
  };
  return {
    parameters: {
      ...base,
      properties: {
        ...base.properties,
        path: { ...base.properties?.path, description: pathDescription },
        host: hostProperty(),
      },
    },
  };
}

// 失败信息带解析出的位置：SDK 的工具错误只说路径，这里补一行目标位置（找不到文件 / 目录这一类）。
const MISSING = /^(ENOENT|Path not found|File not found|Not a directory)/;

function withLocation(err: unknown, at: Located | null): unknown {
  if (!(err instanceof Error) || !at) return err;
  if (!MISSING.test(err.message)) return err;
  err.message = `${err.message}\n(on ${at.shown})`;
  return err;
}

/** bash 的声明：去掉 timeout（到点杀掉），换成 remind_after（到点转后台、继续跑）。 */
function bashDeclaration(upstream: string) {
  return {
    description: `${upstream.replace(/ Optionally provide a timeout in seconds\.$/, "")} There is no timeout: a command that is still running after remind_after seconds is NOT killed. The call returns, the command continues as a background job, and you are notified when it finishes.`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        host: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Where to run: a directory written <host>:<name> (see list_directories), e.g. dev1:train. It is the working directory of this command only; the current directory does not change. A host on its own is not accepted. Omit to run in the current directory.",
        },
        remind_after: {
          type: "number",
          minimum: 0,
          maximum: 86400,
          description:
            "Seconds a blocking call may run before it returns and the command continues in the background (optional; the default comes from settings, 10 minutes unless changed). 0 = never return early.",
        },
      },
      required: ["command"],
    } as never,
  };
}

/**
 * 注册 7 个同名工具。每次调用取目标 directory 的环境：
 * 本机不传 operations，行为与 SDK 原样一致；ssh 经环境原语走远程。
 * 六个文件工具按 host 与 path 路由（`locate`），bash 按 host 取工作目录（`locateDirectory`）。
 */
export function routedToolsExtension(
  locateDirectory: (host: string | undefined) => Promise<Where>,
  // 隐私变量的真值（名字 → 值）；bash 启动进程前才替换占位符，见 ADR-0051。
  variables?: () => ReadonlyMap<string, string>,
  // 后台任务：bash 到提醒时间转后台、job_start 内层调用写日志（subagent.md §3）。
  background?: { jobs: JobManager; owner: string },
  // 端口发现：bash 的输出里认出的本机端口记进这里（已按这次命令实际所在的环境归好类）。
  ports?: { note(envId: string, port: number): void },
  // 位置解析（session/address.ts）：env 是目标主机，cwd 是归属目录，path 是绝对路径，
  // at 是解析结果本身（失败信息里带上 `host:绝对路径`）。只有 bash 的调用方可以不传。
  // bash 走上面的 locateDirectory：它不经 path，工作目录就是那条命令的落点。
  locate: (
    host: string | undefined,
    path: string | undefined,
  ) => Promise<{
    env: ExecEnv;
    path: string;
    cwd: string;
    at?: Located;
  }> = () => {
    throw new Error("address resolution is not available in this session");
  },
): ExtensionFactory {
  return (pi) => {
    const route = (
      make: (cwd: string, options?: object) => unknown,
      remote: (env: ExecEnv) => unknown,
      prepare?: (
        params: unknown,
      ) => Promise<{ params: unknown; env: Record<string, string> } | null>,
      // 包一层 operations（本机时入参为 undefined）；bash 用它做流式输出遮罩与转后台，
      // target 是这次调用实际所在的环境与目录（端口归属、转后台都按它）。
      wrap?: (ops: unknown, params: unknown, target: Where) => unknown,
      // 覆盖 SDK 工具的声明（bash 去掉 timeout 换成 remind_after；文件工具加 host、改 path 的描述）。
      declare?: object | ((proto: AnyDef) => object),
      // 按 host + path 路由（六个文件工具）；bash 传 false，只按 host 取目录。
      byAddress = true,
    ) => {
      const proto = make(process.cwd()) as AnyDef;
      pi.registerTool({
        ...proto,
        ...(typeof declare === "function" ? declare(proto) : declare),
        async execute(
          id: string,
          params: unknown,
          signal: unknown,
          onUpdate: unknown,
          ctx: object,
        ) {
          const asked = params as { host?: string; path?: string };
          // 同一个问题只一种解法：文件工具走地址解析，bash 走目录解析，结果收成同一个形状。
          const target: {
            env: ExecEnv;
            cwd: string;
            path?: string;
            at?: Located;
          } = byAddress
            ? await locate(asked.host, asked.path)
            : await locateDirectory(asked.host);
          const { env, cwd } = target;
          // SDK 工具优先用 ctx.cwd；会话中途切换 directory 后它仍是启动时的目录，必须覆盖。
          const c = Object.create(ctx ?? null, {
            cwd: { value: cwd, enumerable: true },
          });
          const local = env.kind !== "ssh";
          const sub = await prepare?.(params);
          const base = local ? undefined : remote(env);
          const ops = wrap?.(base, params, target) ?? base;
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
          // path 换成本次解析出的绝对路径（缺省时就是目录本身）；SDK 工具忽略多余的 host。
          const forwarded = byAddress
            ? { ...(input as object), path: target.path }
            : input;
          try {
            return await def.execute(id, forwarded, signal, onUpdate, c);
          } catch (err) {
            // bash 到了提醒时间转成后台任务：这次调用正常返回，不是失败。
            if (err instanceof Detached)
              return {
                content: [{ type: "text" as const, text: err.message }],
                details: undefined,
              };
            throw withLocation(err, target.at ?? null);
          }
        },
      } as never);
    };

    route(
      createReadToolDefinition as never,
      (env) => ({
        readFile: (p: string) => env.readFile(p),
        access: (p: string) => accessible(env, p),
        detectImageMimeType: async (p: string) =>
          IMAGE_MIME[path.posix.extname(p).toLowerCase()] ?? null,
      }),
      // gif 作为图片输入无法被模型解析，读之前就拒绝；其余文件照常。
      async (params) => {
        assertReadableFile((params as { path?: unknown }).path);
        return null;
      },
      undefined,
      (proto) =>
        fileDeclaration(
          proto,
          "Path of the file to read: relative to the base set by host, or absolute",
        ),
    );
    route(
      createWriteToolDefinition as never,
      (env) => ({
        writeFile: (p: string, c: string) => env.writeFile(p, c),
        mkdir: (d: string) => env.mkdirp(d),
      }),
      undefined,
      undefined,
      (proto) =>
        fileDeclaration(
          proto,
          "Path of the file to write: relative to the base set by host, or absolute",
        ),
    );
    route(
      createEditToolDefinition as never,
      (env) => ({
        readFile: (p: string) => env.readFile(p),
        writeFile: (p: string, c: string) => env.writeFile(p, c),
        access: (p: string) => accessible(env, p),
      }),
      undefined,
      undefined,
      (proto) =>
        fileDeclaration(
          proto,
          "Path of the file to edit: relative to the base set by host, or absolute",
        ),
    );
    route(
      createBashToolDefinition as never,
      (env) => sshBashOperations(env),
      async (params) => {
        // remind_after 只在转后台时用，不传给 SDK 的 bash。
        const { remind_after: _r, ...p } = params as {
          command?: unknown;
          remind_after?: unknown;
        };
        const values = variables?.();
        if (!values?.size || typeof p.command !== "string")
          return { params: p, env: {} };
        const r = await substitute(p.command, values);
        return { params: { ...p, command: r.command }, env: r.env };
      },
      // 输出里的真值换回占位符（ADR-0053）；每次调用取最新清单。再在外层接后台任务。
      (ops, params, target) => {
        const masker = new Masker(
          [...(variables?.() ?? [])].map(([name, value]) => ({ name, value })),
        );
        const masked = masker.empty
          ? undefined
          : maskBashOperations(
              (ops as BashOperations | undefined) ??
                createLocalBashOperations(),
              masker,
            );
        const base = masked ?? (ops as BashOperations | undefined);
        // 端口发现包在遮罩之内、转后台之前：输出原样透传，只顺带记一笔。
        // 环境 id 在命令启动时就定下：命令跑着时会话切了目录，端口也还是属于启动它的那个环境。
        const envId = target.env.id;
        const scanned =
          ports === undefined
            ? base
            : scanBashOperations(base ?? createLocalBashOperations(), (p) =>
                ports.note(envId, p),
              );
        if (!background) return scanned;
        const seconds = (params as { remind_after?: unknown })?.remind_after;
        return jobBashOperations(scanned ?? createLocalBashOperations(), {
          ...background,
          remindMs:
            typeof seconds === "number" && seconds >= 0
              ? seconds * 1000
              : background.jobs.defaultRemindMs(),
        });
      },
      bashDeclaration(
        (createBashToolDefinition(process.cwd()) as { description: string })
          .description,
      ),
      false,
    );
    route(
      createLsToolDefinition as never,
      (env) => ({
        exists: async (p: string) => (await env.stat(p)) !== null,
        stat: async (p: string) => {
          const s = await env.stat(p);
          if (!s) throw missing(p);
          return { isDirectory: () => s.isDirectory };
        },
        readdir: async (p: string) => (await env.readdir(p)).map((e) => e.name),
      }),
      undefined,
      undefined,
      (proto) =>
        fileDeclaration(
          proto,
          "Directory to list (default: the base set by host)",
        ),
    );
    route(
      createFindToolDefinition as never,
      (env) => ({
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
      }),
      undefined,
      undefined,
      (proto) =>
        fileDeclaration(
          proto,
          "Directory to search in (default: the base set by host)",
        ),
    );

    // grep 的 SDK 实现固定本机起 rg，ssh 环境整体换成远程实现。
    const grepProto = createGrepToolDefinition(process.cwd());
    pi.registerTool({
      ...grepProto,
      ...fileDeclaration(
        grepProto as never,
        "Directory or file to search (default: the base set by host)",
      ),
      async execute(
        id: string,
        params: GrepToolInput & { host?: string },
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: object,
      ) {
        const t = await locate(params.host, params.path);
        const { env, cwd } = t;
        const p = { ...params, path: t.path } as GrepToolInput;
        // 本机与虚拟主机上的文件都在 Server 本机，走 SDK 本地实现；ssh 走环境原语。
        if (env.kind !== "ssh") {
          const c = Object.create(ctx ?? null, {
            cwd: { value: cwd, enumerable: true },
          });
          return (
            createGrepToolDefinition(cwd) as unknown as {
              execute: (...a: unknown[]) => Promise<unknown>;
            }
          ).execute(id, p, signal, onUpdate, c) as never;
        }
        return sshGrep(env, cwd, p, signal);
      },
    } as never);
  };
}
