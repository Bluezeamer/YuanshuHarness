import path from "node:path";
import { parseArgs } from "node:util";
import { parseCidr, TOKEN_PATTERN } from "./auth.js";
import { AUTO_INSTALL_ENV, BROWSER_ENV } from "./browser/engine/install.js";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  // 全局资源目录（命名流程等），缺省 ~/.ys；由 parseConfig 填好。
  ysHome?: string;
  token?: string;
  allowCidrs: string[];
  // 额外放行的页面来源，见 auth.ts 的 originAllowed。
  trustedOrigins?: string[];
  // 服务转发用的出口端口段（含两端）；缺省值由接线处给。
  forwardPorts?: { from: number; to: number };
  // 未给时用终端管理器的默认上限。
  maxTerminals?: number;
}

export type Parsed =
  | { kind: "help" }
  | { kind: "serve"; config: Config }
  | { kind: "error"; message: string };

const ENV_HOST = "YUANSHU_HOST";
const ENV_PORT = "YUANSHU_PORT";
const ENV_DATA_DIR = "YUANSHU_DATA_DIR";
const ENV_TOKEN = "YUANSHU_TOKEN";
const ENV_ALLOW_CIDR = "YUANSHU_ALLOW_CIDR";
const ENV_TRUSTED_ORIGINS = "YUANSHU_TRUSTED_ORIGINS";
const ENV_FORWARD_PORTS = "YUANSHU_FORWARD_PORTS";
const ENV_MAX_TERMINALS = "YUANSHU_MAX_TERMINALS";
const ENV_YS_HOME = "YS_HOME";
const KNOWN_ENV = new Set([
  ENV_HOST,
  ENV_PORT,
  ENV_DATA_DIR,
  ENV_TOKEN,
  ENV_ALLOW_CIDR,
  ENV_TRUSTED_ORIGINS,
  ENV_FORWARD_PORTS,
  ENV_MAX_TERMINALS,
  // 浏览器引擎自己读这两个，这里只放行，免得被当成拼错的变量
  BROWSER_ENV,
  AUTO_INSTALL_ENV,
]);

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7420;

const options = {
  host: { type: "string" },
  port: { type: "string" },
  "data-dir": { type: "string" },
  token: { type: "string" },
  "allow-cidr": { type: "string" },
  "trusted-origin": { type: "string" },
  "forward-ports": { type: "string" },
  "max-terminals": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

const fail = (message: string): Parsed => ({ kind: "error", message });

function parsePort(raw: string): number | undefined {
  if (!/^[0-9]+$/.test(raw)) return undefined;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : undefined;
}

function parsePositiveInt(raw: string): number | undefined {
  if (!/^[0-9]+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

// 只含 scheme://host[:port]，不带路径与结尾斜杠：与浏览器给的 Origin 逐字相同才好比。
function isOrigin(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      (u.protocol === "http:" || u.protocol === "https:") && u.origin === raw
    );
  } catch {
    return false;
  }
}

// 端口段写成 `<起>-<止>`，两端都是 1–65535 的十进制整数。
function parsePortRange(raw: string): { from: number; to: number } | undefined {
  const m = /^([0-9]+)-([0-9]+)$/.exec(raw);
  if (!m) return undefined;
  const from = parsePort(m[1] as string);
  const to = parsePort(m[2] as string);
  if (from === undefined || to === undefined || from > to) return undefined;
  return { from, to };
}

interface Source {
  name: string;
  value: string | undefined;
}

// 每个出现过的来源都要通过校验，哪怕最终被更高优先级的来源覆盖；取第一个（优先级最高）的值。
function resolve<T>(
  sources: Source[],
  convert: (raw: string) => T | undefined,
  rule: string,
  secret = false,
): { error: string } | { value: T | undefined } {
  let chosen: T | undefined;
  for (const { name, value } of sources) {
    if (value === undefined) continue;
    const converted = convert(value);
    if (converted === undefined) {
      return {
        error: secret
          ? `${name} ${rule}`
          : `${name} ${rule}（实际为「${value}」）`,
      };
    }
    chosen ??= converted;
  }
  return { value: chosen };
}

// 纯函数：不读进程全局状态，home 与 cwd 由调用方传入。
export function parseConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  home: string,
  cwd: string,
): Parsed {
  let args: ReturnType<
    typeof parseArgs<{ options: typeof options; allowPositionals: true }>
  >;
  try {
    args = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (args.values.help) return { kind: "help" };

  const [command, ...extra] = args.positionals;
  if (command === undefined) return fail("缺少子命令");
  if (command !== "serve") return fail(`未知子命令：${command}`);
  if (extra.length > 0) return fail(`多余的参数：${extra.join(" ")}`);

  // 拼错的环境变量与拼错的命令行参数是同一类静默错误，同样拒绝。
  for (const key of Object.keys(env)) {
    if (key.startsWith("YUANSHU_") && !KNOWN_ENV.has(key)) {
      return fail(`未知的环境变量：${key}`);
    }
  }

  const nonEmpty = (raw: string) => (raw === "" ? undefined : raw);
  const host = resolve(
    [
      { name: "--host", value: args.values.host },
      { name: ENV_HOST, value: env[ENV_HOST] },
    ],
    nonEmpty,
    "不能为空",
  );
  if ("error" in host) return fail(host.error);

  const port = resolve(
    [
      { name: "--port", value: args.values.port },
      { name: ENV_PORT, value: env[ENV_PORT] },
    ],
    parsePort,
    "必须是 1–65535 的十进制整数",
  );
  if ("error" in port) return fail(port.error);

  const dataDir = resolve(
    [
      { name: "--data-dir", value: args.values["data-dir"] },
      { name: ENV_DATA_DIR, value: env[ENV_DATA_DIR] },
    ],
    (raw) => (raw === "" ? undefined : path.resolve(cwd, raw)),
    "不能为空",
  );
  if ("error" in dataDir) return fail(dataDir.error);

  const ysHome = resolve(
    [{ name: ENV_YS_HOME, value: env[ENV_YS_HOME] }],
    (raw) => (raw === "" ? undefined : path.resolve(cwd, raw)),
    "不能为空",
  );
  if ("error" in ysHome) return fail(ysHome.error);

  const token = resolve(
    [
      { name: "--token", value: args.values.token },
      { name: ENV_TOKEN, value: env[ENV_TOKEN] },
    ],
    (raw) => (TOKEN_PATTERN.test(raw) ? raw : undefined),
    "必须至少 32 个字符，且只含 A-Za-z0-9._~-",
    true,
  );
  if ("error" in token) return fail(token.error);

  const allowCidrs = resolve(
    [
      { name: "--allow-cidr", value: args.values["allow-cidr"] },
      { name: ENV_ALLOW_CIDR, value: env[ENV_ALLOW_CIDR] },
    ],
    (raw) => {
      const items = raw.split(",");
      return items.every((i) => parseCidr(i)) ? items : undefined;
    },
    "必须是逗号分隔的 CIDR 列表，如 10.0.0.0/8,fd00::/8",
  );
  if ("error" in allowCidrs) return fail(allowCidrs.error);

  const trustedOrigins = resolve(
    [
      { name: "--trusted-origin", value: args.values["trusted-origin"] },
      { name: ENV_TRUSTED_ORIGINS, value: env[ENV_TRUSTED_ORIGINS] },
    ],
    (raw) => {
      const items = raw.split(",").map((i) => i.trim());
      return items.every(isOrigin) ? items : undefined;
    },
    "必须是逗号分隔的页面来源列表，如 https://a.example.com,http://10.0.0.5:8080",
  );
  if ("error" in trustedOrigins) return fail(trustedOrigins.error);

  const forwardPorts = resolve(
    [
      { name: "--forward-ports", value: args.values["forward-ports"] },
      { name: ENV_FORWARD_PORTS, value: env[ENV_FORWARD_PORTS] },
    ],
    parsePortRange,
    "必须是 <起>-<止> 形式的端口段，两端都是 1–65535 的十进制整数且起不大于止",
  );
  if ("error" in forwardPorts) return fail(forwardPorts.error);

  const maxTerminals = resolve(
    [
      { name: "--max-terminals", value: args.values["max-terminals"] },
      { name: ENV_MAX_TERMINALS, value: env[ENV_MAX_TERMINALS] },
    ],
    parsePositiveInt,
    "必须是正的十进制整数",
  );
  if ("error" in maxTerminals) return fail(maxTerminals.error);

  return {
    kind: "serve",
    config: {
      host: host.value ?? DEFAULT_HOST,
      port: port.value ?? DEFAULT_PORT,
      dataDir: dataDir.value ?? path.join(home, ".yuanshu"),
      ysHome: ysHome.value ?? path.join(home, ".ys"),
      ...(token.value === undefined ? {} : { token: token.value }),
      allowCidrs: allowCidrs.value ?? [],
      ...(trustedOrigins.value === undefined
        ? {}
        : { trustedOrigins: trustedOrigins.value }),
      ...(forwardPorts.value === undefined
        ? {}
        : { forwardPorts: forwardPorts.value }),
      ...(maxTerminals.value === undefined
        ? {}
        : { maxTerminals: maxTerminals.value }),
    },
  };
}
