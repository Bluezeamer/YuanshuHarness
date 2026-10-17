import { parseArgs } from "node:util";
import { attach } from "./attach.js";
import { ClientError, createSession, listSessions } from "./http.js";
import { parseClientOptions } from "./options.js";

export const CLIENT_COMMANDS = ["sessions", "new", "attach"] as const;

export const CLIENT_USAGE = `客户端命令（服务地址取 --url，其次环境变量 YUANSHU_URL，默认 http://127.0.0.1:7420）：
  yuanshu sessions [--url <地址>]        列出会话
  yuanshu new [--url <地址>]             创建会话，只向 stdout 打印会话 id
  yuanshu attach <id> [--url <地址>]     接入会话：输入一行发一条消息，/stop 中止运行，/quit 退出
访问令牌只读环境变量 YUANSHU_TOKEN。
`;

export interface ClientDeps {
  env: Record<string, string | undefined>;
  stdin: NodeJS.ReadableStream;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  signal: AbortSignal;
}

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

export async function runClient(
  command: string,
  argv: string[],
  deps: ClientDeps,
): Promise<number> {
  const usage = (message: string) => {
    deps.stderr.write(`yuanshu: ${message}\n\n${CLIENT_USAGE}`);
    return EXIT_USAGE;
  };

  let args: ReturnType<
    typeof parseArgs<{
      options: { url: { type: "string" } };
      allowPositionals: true;
    }>
  >;
  try {
    args = parseArgs({
      args: argv,
      options: { url: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }

  const [id, ...extra] = args.positionals;
  const wantsId = command === "attach";
  if (wantsId && id === undefined) return usage("attach 缺少会话 id");
  if (wantsId ? extra.length > 0 : id !== undefined)
    return usage(
      `多余的参数：${(wantsId ? extra : args.positionals).join(" ")}`,
    );

  const parsed = parseClientOptions(args.values.url, deps.env);
  if (!parsed.ok) return usage(parsed.message);
  const opts = parsed.options;

  try {
    if (command === "sessions") {
      const list = await listSessions(opts);
      if (list.length === 0) deps.stdout.write("没有会话\n");
      for (const s of list)
        deps.stdout.write(
          `${s.id}\t${s.running ? "running" : "idle"}\t${s.name ?? ""}\n`,
        );
      return 0;
    }
    if (command === "new") {
      deps.stdout.write(`${await createSession(opts)}\n`);
      return 0;
    }
    return await attach(opts, id as string, deps);
  } catch (err) {
    if (!(err instanceof ClientError)) throw err;
    deps.stderr.write(`yuanshu: ${err.message}\n`);
    return EXIT_FAILURE;
  }
}
