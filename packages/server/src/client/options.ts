export interface ClientOptions {
  url: string;
  token: string | null;
}

export type ParseResult =
  | { ok: true; options: ClientOptions }
  | { ok: false; message: string };

const DEFAULT_URL = "http://127.0.0.1:7420";

function isHttpUrl(v: string): boolean {
  try {
    const { protocol } = new URL(v);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// 地址：--url > YUANSHU_URL > 默认值；令牌只读环境变量，客户端不接受 --token。
export function parseClientOptions(
  urlFlag: string | undefined,
  env: Record<string, string | undefined>,
): ParseResult {
  const sources = [
    { name: "--url", value: urlFlag },
    { name: "YUANSHU_URL", value: env.YUANSHU_URL },
  ];
  let url = DEFAULT_URL;
  for (const { name, value } of sources) {
    if (value === undefined) continue;
    if (!isHttpUrl(value)) {
      return {
        ok: false,
        message: `${name} 必须是 http 或 https 地址（实际为「${value}」）`,
      };
    }
    url = value;
    break;
  }
  return { ok: true, options: { url, token: env.YUANSHU_TOKEN || null } };
}
