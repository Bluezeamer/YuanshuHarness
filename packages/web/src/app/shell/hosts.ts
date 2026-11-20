import type { ConnectionList } from "../../api/connections";
import type { HostInfo } from "../../features/workspace/layoutContext";

// 主机 id 约定：布局模型里 Server 本机叫 "server"，其余主机用连接 id；
// 服务端的环境 id 里 Server 本机叫 "local"（与连接 id 同一命名空间）。壳是两套 id 的唯一翻译处。
export const SERVER_HOST = "server";
export const LOCAL_ENV = "local";

export const hostIdOf = (environmentId: string | null | undefined): string =>
  !environmentId || environmentId === LOCAL_ENV ? SERVER_HOST : environmentId;

export const environmentIdOf = (hostId: string): string =>
  hostId === SERVER_HOST ? LOCAL_ENV : hostId;

/** Server 本机永远在；其余只列已激活的连接（未激活的主机不能开文件/终端标签）。 */
export function hostsOf(list: ConnectionList | null): HostInfo[] {
  const server: HostInfo = {
    id: SERVER_HOST,
    name: list?.server.label || "Server",
  };
  const rest = (list?.connections ?? [])
    .filter((c) => c.status === "active")
    .map((c): HostInfo => ({ id: c.id, name: c.label }));
  return [server, ...rest];
}
