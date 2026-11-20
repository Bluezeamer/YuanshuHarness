// 工作区与会话能到达哪些环境：代理按工作区放行服务与文件，工具按会话的当前目录解析 `host:端口`。
// 这里只做判定，目录与环境的来源由接线处注入。
import path from "node:path";
import { SERVER_HOST_ID } from "../env/host-id.js";
import { isInside, isSensitive } from "../permission/paths.js";
import { ATTACHMENT_HOST, LOCAL_HOST } from "../session/address.js";
import { LOCAL_ENV_ID } from "../store/environments.js";
import type { ProxyContext } from "./net/proxy.js";
import type { TargetOptions } from "./net/target.js";

export interface ReachDir {
  environmentId: string;
  path: string;
}

/**
 * 工作区的出站范围：页面里点的链接（裸 localhost）指向主目录（第一个）所在的环境；服务放行各目录所在环境上的端口；
 * 文件只放行各目录之内、且不在敏感名单里的路径（浏览器不能绕过读文件的审批去看 .env）。
 * 目录清单每次请求现取：工作区改了目录，下一个请求就按新的来。
 * 服务端口按环境整体放行（只拒 Server 自己的端口）：代理层分不清请求出自哪个页面，
 * 收窄到见过的端口会误伤「前端 5173 页面直接调后端 8000」这类跳端口请求；按见过 / 已批准的收窄放在工具层。
 */
export function workspaceReach(
  directories: () => ReachDir[],
  serverPort?: () => number | null,
): ProxyContext {
  return {
    get loopbackEnvId() {
      return directories()[0]?.environmentId ?? null;
    },
    allowService: (envId, port) => {
      if (envId === LOCAL_ENV_ID && port === serverPort?.()) return false;
      return directories().some((d) => d.environmentId === envId);
    },
    allowFile: (envId, realPath) =>
      !isSensitive(realPath) &&
      directories().some(
        (d) =>
          d.environmentId === envId && isInside(d.path, realPath, path.posix),
      ),
  };
}

/**
 * 工具解析 `主机:端口` 与绝对路径用：主机名与目录清单一致 —— `local` 是工作区主目录所在的主机，
 * `server` 永远是 Server 本机，其余按连接名或环境 id 找。附件区不是主机（浏览器到不了那里）。
 * `defaultEnvId` 只剩一个用途：不写主机的绝对路径（`/…`）落在当前目录所在的环境。
 */
export function targetOptions(
  envs: () => { id: string; name: string }[],
  defaultEnvId: string | null,
  primaryEnvId: string | null,
): TargetOptions {
  return {
    findEnv(name) {
      const lower = name.toLowerCase();
      // 附件区是虚拟主机，浏览器不到那里：当成没有这台主机
      if (lower === ATTACHMENT_HOST) return null;
      if (lower === LOCAL_HOST) return primaryEnvId;
      if (lower === SERVER_HOST_ID) return LOCAL_ENV_ID;
      const list = envs();
      return (
        list.find((e) => e.id.toLowerCase() === lower)?.id ??
        list.find((e) => e.name.toLowerCase() === lower)?.id ??
        null
      );
    },
    defaultEnvId,
  };
}
