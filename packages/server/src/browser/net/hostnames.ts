// 代理虚拟主机名的编码与解码：`<环境>.localhost:<端口>` 是服务，`<环境>.files.localhost` 是文件。
// 只在这一处拼主机名，别处一律经这些函数。

import { SERVER_HOST_ID } from "../../env/host-id.js";
import { LOCAL_ENV_ID } from "../../store/environments.js";

const FILES_LABEL = "files";
const SUFFIX = ".localhost";

export interface VirtualHost {
  kind: "service" | "file";
  envId: string;
}

/** 环境 id → 主机名里的标签；本机用 `server`，其余环境 id 本身就是合法 DNS 标签。 */
export function hostLabel(envId: string): string {
  return envId === LOCAL_ENV_ID ? SERVER_HOST_ID : envId;
}

/** 主机名里的标签 → 环境 id。 */
export function envIdOfLabel(label: string): string {
  const lower = label.toLowerCase();
  return lower === SERVER_HOST_ID ? LOCAL_ENV_ID : lower;
}

/** 服务地址的虚拟主机名（不含协议与路径）。 */
export function serviceHost(envId: string, port: number): string {
  return `${hostLabel(envId)}${SUFFIX}:${port}`;
}

/** 文件地址：路径按段编码，保留 `/`。 */
export function fileUrl(envId: string, absPath: string): string {
  const encoded = absPath.split("/").map(encodeURIComponent).join("/");
  return `http://${hostLabel(envId)}.${FILES_LABEL}${SUFFIX}${encoded}`;
}

/** `<标签>.localhost` → 服务，`<标签>.files.localhost` → 文件；其他返回 null。大小写不敏感。 */
export function parseVirtualHost(hostname: string): VirtualHost | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host.endsWith(SUFFIX)) return null;
  const parts = host.slice(0, -SUFFIX.length).split(".");
  const label = parts[0];
  if (!label) return null;
  if (parts.length === 1)
    return { kind: "service", envId: envIdOfLabel(label) };
  if (parts.length === 2 && parts[1] === FILES_LABEL)
    return { kind: "file", envId: envIdOfLabel(label) };
  return null;
}
