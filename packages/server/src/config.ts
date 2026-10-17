import path from "node:path";
import { parseArgs } from "node:util";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
}

export type Parsed =
  | { kind: "help" }
  | { kind: "serve"; config: Config }
  | { kind: "error"; message: string };

const ENV_HOST = "YUANSHU_HOST";
const ENV_PORT = "YUANSHU_PORT";
const ENV_DATA_DIR = "YUANSHU_DATA_DIR";
const KNOWN_ENV = new Set([ENV_HOST, ENV_PORT, ENV_DATA_DIR]);

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7420;

const options = {
  host: { type: "string" },
  port: { type: "string" },
  "data-dir": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

const fail = (message: string): Parsed => ({ kind: "error", message });

function parsePort(raw: string): number | undefined {
  if (!/^[0-9]+$/.test(raw)) return undefined;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : undefined;
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
): { error: string } | { value: T | undefined } {
  let chosen: T | undefined;
  for (const { name, value } of sources) {
    if (value === undefined) continue;
    const converted = convert(value);
    if (converted === undefined) {
      return { error: `${name} ${rule}（实际为「${value}」）` };
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

  return {
    kind: "serve",
    config: {
      host: host.value ?? DEFAULT_HOST,
      port: port.value ?? DEFAULT_PORT,
      dataDir: dataDir.value ?? path.join(home, ".yuanshu"),
    },
  };
}
