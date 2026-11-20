// MCP 版本固定：从 npx / uvx 命令里认出包与版本、解析最新版与候选版本、把 pkg@版本 写回命令。
// 没有「可更新」状态：命令里带 x.y.z 就是固定，否则就是浮动（每次启动解析最新）。
import { execFile } from "node:child_process";
import path from "node:path";
import type { McpConfig } from "../store/mcp.js";

export type PkgRuntime = "npm" | "pypi";

export interface McpSource {
  runtime: PkgRuntime;
  pkg: string;
  /** 命令里写死的版本（x.y.z）；null = 浮动。 */
  version: string | null;
  /** 包名所在的 args 下标，写回时替换这一项。 */
  argIndex: number;
}

// x.y.z，可带预发布 / 构建后缀。
export const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

const NPM_SPEC = /^(@[a-z0-9][\w.~-]*\/)?([a-z0-9][\w.~-]*)(?:@(.+))?$/i;
const PYPI_SPEC = /^([a-z0-9][\w.-]*)(?:(?:@|==)(.+))?$/i;

const launcher = (command: string): PkgRuntime | null => {
  const base = path
    .basename(command)
    .toLowerCase()
    .replace(/\.(cmd|exe)$/, "");
  return base === "npx" ? "npm" : base === "uvx" ? "pypi" : null;
};

// 只认最常见的写法：第一个不带 - 的参数就是包规格；-p / --package / --from 这类另指包的写法不认。
export function parseSource(config: McpConfig): McpSource | null {
  if (config.transport !== "stdio") return null;
  const runtime = launcher(config.command);
  if (!runtime) return null;
  if (config.args.some((a) => ["-p", "--package", "--from"].includes(a)))
    return null;
  const argIndex = config.args.findIndex((a) => !a.startsWith("-"));
  if (argIndex < 0) return null;
  const spec = config.args[argIndex] as string;
  if (runtime === "npm") {
    const m = NPM_SPEC.exec(spec);
    if (!m) return null;
    const version = m[3];
    return {
      runtime,
      pkg: `${m[1] ?? ""}${m[2]}`,
      version: version && VERSION_RE.test(version) ? version : null,
      argIndex,
    };
  }
  const m = PYPI_SPEC.exec(spec);
  if (!m) return null;
  const version = m[2];
  return {
    runtime,
    pkg: m[1] as string,
    version: version && VERSION_RE.test(version) ? version : null,
    argIndex,
  };
}

/** 把 args 里的包规格换成 pkg@版本，其余不动。 */
export function withVersion(
  config: McpConfig,
  source: McpSource,
  version: string,
): McpConfig {
  if (config.transport !== "stdio") return config;
  const args = [...config.args];
  args[source.argIndex] = `${source.pkg}@${version}`;
  return { ...config, args };
}

// ── 版本排序 ────────────────────────────────────────────────

const parseVer = (v: string) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec(v);
  return m
    ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null }
    : null;
};

/** 新的在前；预发布低于同号正式版；解析不了的排最后。 */
export function compareVersionsDesc(a: string, b: string): number {
  const x = parseVer(a);
  const y = parseVer(b);
  if (!x || !y) return x ? -1 : y ? 1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = (y.n[i] as number) - (x.n[i] as number);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  return x.pre === null ? -1 : y.pre === null ? 1 : y.pre.localeCompare(x.pre);
}

// ── 版本解析（访问外网；测试里换成桩） ──────────────────────────

export interface PackageInfo {
  latest: string;
  versions: string[];
  description: string | null;
}

export type ResolveFailure =
  | "network_unavailable"
  | "package_not_found"
  | "resolve_failed";

export class ResolveError extends Error {
  constructor(
    readonly code: ResolveFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface VersionResolver {
  resolve(runtime: PkgRuntime, pkg: string): Promise<PackageInfo>;
}

const NETWORK_HINT =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|fetch failed|network|socket hang up/i;

/** 把 npm / fetch 的失败文本归类成明确的原因。 */
export function classifyFailure(text: string, pkg: string): ResolveError {
  if (/E404|404 Not Found|HTTP 404/i.test(text))
    return new ResolveError("package_not_found", `仓库里没有 ${pkg}`);
  if (NETWORK_HINT.test(text))
    return new ResolveError(
      "network_unavailable",
      `无法访问包仓库（无网络？）：${text.trim().slice(0, 200)}`,
    );
  return new ResolveError(
    "resolve_failed",
    `解析 ${pkg} 的版本失败：${text.trim().slice(0, 200)}`,
  );
}

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** `npm view <pkg> --json` 的输出；只有一个版本时 versions 可能是字符串。 */
export function parseNpmView(stdout: string, pkg: string): PackageInfo {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new ResolveError("resolve_failed", `无法解析 npm 的输出（${pkg}）`);
  }
  const tags = (j["dist-tags"] ?? {}) as Record<string, unknown>;
  const latest = String(tags.latest ?? j.version ?? "");
  const versions =
    typeof j.versions === "string" ? [j.versions] : strArray(j.versions);
  if (latest === "")
    throw new ResolveError("resolve_failed", `${pkg} 没有可用版本`);
  return {
    latest,
    versions,
    description:
      typeof j.description === "string" && j.description.trim() !== ""
        ? j.description.trim()
        : null,
  };
}

/** PyPI JSON API 的响应：只取未被撤回的版本。 */
export function parsePypi(j: unknown, pkg: string): PackageInfo {
  const o = (j ?? {}) as {
    info?: { version?: string; summary?: string };
    releases?: Record<string, { yanked?: boolean }[]>;
  };
  const latest = o.info?.version;
  if (!latest) throw new ResolveError("resolve_failed", `${pkg} 没有可用版本`);
  const versions = Object.entries(o.releases ?? {})
    .filter(([, files]) => files.some((f) => !f.yanked))
    .map(([v]) => v);
  const summary = o.info?.summary?.trim();
  return { latest, versions, description: summary || null };
}

const run = (cmd: string, args: string[], timeout: number) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const code = (err as { code?: string }).code;
        reject(
          code === "ENOENT"
            ? new ResolveError("resolve_failed", `找不到 ${cmd}，无法解析版本`)
            : new Error(`${stderr}\n${err.message}`),
        );
      },
    );
  });

// 默认实现：npm 走 `npm view`（沿用用户的镜像与代理配置），PyPI 走 JSON API。
export const defaultResolver: VersionResolver = {
  async resolve(runtime, pkg) {
    try {
      if (runtime === "npm")
        return parseNpmView(
          await run("npm", ["view", pkg, "--json"], 30_000),
          pkg,
        );
      const base = (process.env.PYPI_URL ?? "https://pypi.org").replace(
        /\/$/,
        "",
      );
      const res = await fetch(`${base}/pypi/${encodeURIComponent(pkg)}/json`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404)
        throw new ResolveError("package_not_found", `仓库里没有 ${pkg}`);
      if (!res.ok)
        throw new ResolveError(
          "resolve_failed",
          `PyPI 返回 HTTP ${res.status}（${pkg}）`,
        );
      return parsePypi(await res.json(), pkg);
    } catch (err) {
      if (err instanceof ResolveError) throw err;
      const cause = (err as { cause?: { code?: string } }).cause?.code ?? "";
      throw classifyFailure(
        `${cause} ${err instanceof Error ? err.message : String(err)}`,
        pkg,
      );
    }
  },
};
