// 把我们库里的 MCP 登记映射成 pi 的 mcpServers 形状。
//
// 为什么交给 pi：连接、握手、工具注册、OAuth、重连这一整层 pi 已经写好了。
// 我们只保留「库里登记了什么、审批怎么分档、版本怎么 pin」这些属于产品的部分。
// exposure 一律显式写（direct / hidden）：pi 的缺省是 codemode，我们没有装载 codemode 工具。
import { createHash } from "node:crypto";
import type {
  LoadedMcpConfig,
  McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import type { McpServerMeta } from "../store/mcp.js";
import { expandVars, type Reveal, resolveEntries } from "./resolve.js";

/** 取值失败（环境变量没设置、密码库条目已删）而没交给 pi 的服务。 */
export interface ConfigFailure {
  name: string;
  message: string;
}

export type PiMcpConfig = LoadedMcpConfig & { failed: ConfigFailure[] };

/** 配置的指纹（含已解出的变量值，只比较、不保存明文）：与 pi 读走的那份不同，说明登记 / 勾选 / 变量变了。 */
export const configSig = (c: PiMcpConfig): string =>
  createHash("sha1")
    .update(JSON.stringify([c.servers, c.failed]))
    .digest("hex");

/**
 * 一次会话应生效的 server → pi 的条目。
 * `source` 记成我们的库，这样 pi 的 `/mcp` 不会去写一个不存在的配置文件。
 * 取值失败只丢掉那一个服务、记进 `failed`：一个服务的变量没设置，不能让其余服务一起起不来。
 */
export function piMcpConfig(
  servers: readonly McpServerMeta[],
  reveal: Reveal,
): PiMcpConfig {
  const entries: McpServerEntry[] = [];
  const failed: ConfigFailure[] = [];
  for (const s of servers) {
    const base = {
      exposure: s.exposure,
      ...(s.description ? { description: s.description } : {}),
      ...(Object.keys(s.toolExposure).length > 0
        ? { toolExposure: s.toolExposure }
        : {}),
      enabled: s.enabled,
      ...(s.timeout === null ? {} : { timeout: s.timeout }),
    };
    try {
      const config =
        s.config.transport === "stdio"
          ? {
              ...base,
              type: "stdio" as const,
              command: s.config.command,
              args: s.config.args,
              env: resolveEntries(s.config.env, reveal),
              ...(s.config.cwd ? { cwd: s.config.cwd } : {}),
            }
          : {
              ...base,
              type: "http" as const,
              url: expandVars("url", s.config.url),
              headers: resolveEntries(s.config.headers, reveal),
              ...(s.oauth && typeof s.oauth === "object"
                ? { oauth: s.oauth as never }
                : {}),
            };
      entries.push({
        name: s.name,
        config,
        source: `yuanshu:${s.name}`,
        scope: "extension",
      });
    } catch (e) {
      failed.push({
        name: s.name,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return {
    servers: entries,
    errors: failed.map((f) => `${f.name}: ${f.message}`),
    failed,
    // 没有装载 codemode 工具，不让 pi 去激活它
    autoEnableCodemode: false,
  };
}
