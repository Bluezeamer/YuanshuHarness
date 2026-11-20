// 从命令输出里认「本机端口」：只认 localhost、127.0.0.1、0.0.0.0、[::1]、[::] 这几种写法。
// 输出是 agent 能影响的（它可以 echo localhost:5432），所以「见过」只是方便它打开自己启动的服务，
// 不是强授权：与 bash 本身已经能 curl 同一个端口相比没有新增能力。

// 颜色码常把地址切碎（`\x1b[36mhttp://localhost:\x1b[1m3000\x1b[0m`），先去掉转义序列。
// biome-ignore lint/suspicious/noControlCharactersInRegex: 要匹配的就是 ESC 字符
const ANSI = /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g;

// 主机名前不能是字母数字（mylocalhost:3000 不算）；只认这几种本机写法，别的 IP 与没有主机名的 :3000 不认。
const HOST_PORT =
  /(?<![A-Za-z0-9.])(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})(?![0-9A-Za-z])/gi;

const PORT_MIN = 1;
const PORT_MAX = 65535;
// 一直不换行的输出别把内存吃光：只留最近的这么多字符。
const PENDING_MAX = 4096;

const stripAnsi = (s: string) => s.replace(ANSI, "");

/** 逐块喂输出（可能把一行切在两块之间）；每认到一个端口就回调一次（同一行里重复的端口只回调一次）。 */
export function createPortScanner(onPort: (port: number) => void): {
  push(chunk: Buffer | string): void;
} {
  let pending = "";

  const scanLine = (line: string): void => {
    const seen = new Set<number>();
    for (const m of line.matchAll(HOST_PORT)) {
      const port = Number(m[1]);
      if (port < PORT_MIN || port > PORT_MAX) continue;
      if (seen.has(port)) continue;
      seen.add(port);
      onPort(port);
    }
  };

  return {
    push(chunk) {
      const raw = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // 只认完整的行：最后一段还没结束，与下一块拼起来再看。
      const lines = stripAnsi(pending + raw).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) scanLine(line);
      if (pending.length > PENDING_MAX) pending = pending.slice(-PENDING_MAX);
    },
  };
}
