// 用户 / agent 给的地址（URL、文件路径、`host:端口`）→ 可导航的目标。
// 这里是唯一把输入翻译成「公网 / 某个环境的服务 / 某个环境的文件」的地方，错误信息直接给人和模型看。
import { fileUrl, parseVirtualHost, serviceHost } from "./hostnames.js";

export type Target =
  | { kind: "public"; url: string }
  | { kind: "service"; envId: string; port: number; url: string }
  | { kind: "file"; envId: string; path: string; url: string };

export interface TargetOptions {
  /** 主机名（目录清单里的 local、server、连接名或环境 id）→ 环境 id；找不到返回 null */
  findEnv(name: string): string | null;
  /** 不写主机的绝对路径（`/…`）落在哪个环境：当前目录所在的环境；null 表示没有默认 */
  defaultEnvId: string | null;
  /**
   * 裸回环地址（localhost:3000）指向哪个环境。用户在地址栏里这样写是常态，指工作区主目录所在的环境；
   * agent 的工具不给它：裸 localhost 说不清是哪台主机，必须写 local:<端口> 或 <主机名>:<端口>。
   */
  loopbackEnvId?: string | null;
}

export class TargetError extends Error {}

const MAX_LENGTH = 4096;

// `主机名:/绝对路径`；`//` 开头的是带协议的地址，交给后面的分支
const HOST_PATH = /^(\[[^\]]*\]|[A-Za-z0-9._-]+):(\/(?!\/).*)$/;
// `host:端口[/路径][?查询][#锚点]`
const HOST_PORT = /^(\[[^\]]*\]|[A-Za-z0-9._-]+):([0-9]{1,5})((?:[/?#].*)?)$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const unsupported = () =>
  new TargetError("只支持 http 与 https 地址、绝对文件路径、host:端口");

// 裸回环地址没有说明是哪台主机：代理内部按工作区主目录路由，工具不替它猜。
const LOOPBACK_NEEDS_HOST =
  "裸 localhost 没有说明是哪台主机：请写 local:<端口>，或 <主机名>:<端口>（主机名见 list_directories）";

const loopbackNeedsHost = () => new TargetError(LOOPBACK_NEEDS_HOST);

const noDefaultFile = () =>
  new TargetError(
    "没有默认目录，无法打开绝对路径：请在前面写主机名，如 local:/绝对路径",
  );

// 裸 `example.com:8080` 与「主机名:端口」无法区分，所以公网域名必须带协议。
const unknownServiceHost = (host: string) =>
  new TargetError(`找不到主机 ${host}；公网地址要带 http:// 或 https:// 前缀`);

const unknownFileHost = (host: string) => new TargetError(`找不到主机 ${host}`);

function toFile(envId: string, absPath: string): Target {
  return { kind: "file", envId, path: absPath, url: fileUrl(envId, absPath) };
}

function toService(envId: string, port: number, rest: string): Target {
  if (port < 1 || port > 65535)
    throw new TargetError(`端口 ${port} 不合法，应在 1–65535 之间`);
  return {
    kind: "service",
    envId,
    port,
    url: `http://${serviceHost(envId, port)}${rest}`,
  };
}

export function resolveTarget(raw: string, opts: TargetOptions): Target {
  const text = raw.trim();
  if (text === "") throw new TargetError("地址不能为空");
  if (text.length > MAX_LENGTH)
    throw new TargetError(`地址过长（超过 ${MAX_LENGTH} 字符）`);

  // 绝对路径落在当前目录所在的环境
  if (text.startsWith("/")) {
    const { defaultEnvId } = opts;
    if (defaultEnvId === null) throw noDefaultFile();
    return toFile(defaultEnvId, text);
  }

  const hostPath = HOST_PATH.exec(text);
  if (hostPath) {
    const host = hostPath[1] as string;
    const envId = opts.findEnv(host);
    if (envId === null) throw unknownFileHost(host);
    return toFile(envId, hostPath[2] as string);
  }

  const hostPort = HOST_PORT.exec(text);
  if (hostPort) {
    const host = (hostPort[1] as string).toLowerCase();
    const loopback = LOOPBACK.has(host);
    if (loopback && !opts.loopbackEnvId) throw loopbackNeedsHost();
    const envId = loopback
      ? (opts.loopbackEnvId as string)
      : opts.findEnv(host);
    if (envId === null) throw unknownServiceHost(host);
    return toService(envId, Number(hostPort[2]), hostPort[3] as string);
  }

  if (!/^https?:\/\//i.test(text)) throw unsupported();

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TargetError(`地址格式不对：${text}`);
  }
  const hostname = url.hostname.toLowerCase();
  const virtual = parseVirtualHost(hostname);

  if (virtual?.kind === "file") {
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      throw new TargetError(`文件地址里的路径无法解码：${url.pathname}`);
    }
    if (!path.startsWith("/"))
      throw new TargetError(`文件地址必须带绝对路径：${text}`);
    return toFile(virtual.envId, path);
  }

  // 虚拟主机名（server.localhost 一类）由代理内部命名，照旧；裸回环不再有默认主机。
  if (virtual?.kind === "service") {
    if (url.protocol !== "http:")
      throw new TargetError("服务地址只支持 http；https 只能用于公网域名");
    return toService(
      virtual.envId,
      url.port === "" ? 80 : Number(url.port),
      `${url.pathname}${url.search}${url.hash}`,
    );
  }

  if (LOOPBACK.has(hostname)) {
    if (url.protocol !== "http:")
      throw new TargetError("服务地址只支持 http；https 只能用于公网域名");
    if (!opts.loopbackEnvId) throw loopbackNeedsHost();
    return toService(
      opts.loopbackEnvId,
      url.port === "" ? 80 : Number(url.port),
      `${url.pathname}${url.search}${url.hash}`,
    );
  }

  return { kind: "public", url: url.href };
}
