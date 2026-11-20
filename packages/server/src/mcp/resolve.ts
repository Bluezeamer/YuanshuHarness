// 登记里 env / headers / url 取值的解析。检测、试装与会话三条路径共用这一份，行为才一致。
import type { McpEntry } from "../store/mcp.js";

/** 取密码库条目的明文；条目已被删除返回 null。 */
export type Reveal = (secretId: string) => string | null;

// 明文里的 ${VAR} 取 Server 进程环境；没设置就点名报错，不悄悄替换成空串。
export function expandVars(key: string, v: string): string {
  return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => {
    const x = process.env[n];
    if (x === undefined)
      throw new Error(
        `${key}：环境变量 ${n} 未设置（\${VAR} 取 Server 的环境）`,
      );
    return x;
  });
}

// 一组 env / headers 的取值：明文展开 ${VAR}；密码库引用取出明文并拼上前缀（如 "Bearer "）。
// 任何一项取不到都抛错并点名是哪一项，不留空值去连。
export function resolveEntries(
  list: McpEntry[],
  reveal: Reveal,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of list) {
    if (e.secretId === undefined) {
      out[e.key] = expandVars(e.key, e.value ?? "");
      continue;
    }
    const v = reveal(e.secretId);
    if (v === null) throw new Error(`${e.key}：引用的密码库条目已不存在`);
    out[e.key] = `${e.prefix ?? ""}${v}`;
  }
  return out;
}
