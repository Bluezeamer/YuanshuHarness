// 位置模型：主机与路径分开写——`host` 参数说在哪台机器（或哪个目录），`path` 永远只是路径。
// 这是唯一的解析实现：六个文件工具、transfer_files、浏览器上传与权限判定都经它。
// 主机名：工作区主目录所在的主机叫 local，两个虚拟主机叫 collab（协作区）与 attachment（附件区），
// Server 所在物理机若不是主目录就叫 server。
// 目录写作 `<host>:<name>`，只能从会话里已登记的目录里选。

import { SERVER_HOST_ID } from "../env/host-id.js";
import type { ExecEnv } from "../env/types.js";
import { isInside, pathOf } from "../permission/paths.js";
import type { Directory } from "../store/directories.js";
import {
  ATTACHMENT_ENV_ID,
  COLLAB_ENV_ID,
  LOCAL_ENV_ID,
} from "../store/environments.js";

export const LOCAL_HOST = "local";
export const COLLAB_HOST = "collab";
export const ATTACHMENT_HOST = "attachment";
export const SERVER_HOST = SERVER_HOST_ID;

/** 虚拟主机（不暴露真实路径）：它们只按 `/` 开头的路径寻址，不是目录。 */
const VIRTUAL_HOSTS: Record<string, string> = {
  [COLLAB_ENV_ID]: COLLAB_HOST,
  [ATTACHMENT_ENV_ID]: ATTACHMENT_HOST,
};
const VIRTUAL_HOST_NAMES = Object.values(VIRTUAL_HOSTS);

/** 目录的引用写法 `<host>:<name>`：列表、报错、通知与工具参数都是它，不在别处手拼。 */
export const directoryRef = (host: string, name: string): string =>
  `${host}:${name}`;

/** 主机名要能写进 `<host>:<name>`：不含空白、冒号与斜杠。 */
const ADDRESSABLE = /^[^/\\:\s]+$/;

/**
 * 一个环境在本会话里的主机名；viewOf 与解析器共用这一份规则。
 * 连接名不能写进地址（含空格等）时改用环境 id（它本身就是合法的标签）。
 */
export function hostLabel(
  envId: string,
  o: {
    primaryEnvId: string | null;
    connectionName: (envId: string) => string | undefined;
  },
): string {
  const virtual = VIRTUAL_HOSTS[envId];
  if (virtual !== undefined) return virtual;
  if (envId === o.primaryEnvId) return LOCAL_HOST;
  if (envId === LOCAL_ENV_ID) return SERVER_HOST;
  const name = o.connectionName(envId);
  return name !== undefined && ADDRESSABLE.test(name) ? name : envId;
}

export interface Located {
  /** 主机名（见 hostLabel）。 */
  host: string;
  /** `host:绝对路径`，给人与模型看的展示形式。 */
  shown: string;
  env: ExecEnv;
  /** 该环境上的绝对路径（环境的路径方言；`~` 已展开；虚拟主机已换算成真实路径；未做 realpath）。 */
  path: string;
  /** 归属的已登记目录：包含该路径的最深的一个；没有就取点名或当前的目录（若在同一主机）；再没有取该主机的第一个目录。 */
  directory: Directory;
}

export interface AddressBook {
  /** 会话可见的主机：local 在最前，其余按目录顺序，虚拟主机在最后（collab 在 attachment 之前）。 */
  hosts(): { label: string; envId: string; directories: Directory[] }[];
  labelOf(envId: string): string;
  /** 目录的引用写法 `<host>:<name>`；列表、报错与通知都用它，保证模型能原样抄回。 */
  refOf(d: Directory): string;
  /** `<host>:<name>` → 会话可见的已登记目录（不含附件区）。不可解析时抛 Error，信息是英文、直接给模型看。 */
  directory(ref: string): Directory;
  /** 文件工具的目标：host 与 path 各自可缺省。不可解析时抛 Error，信息是英文、直接给模型看。 */
  locate(host: string | undefined, path: string | undefined): Promise<Located>;
}

/** 虚拟主机不是目录：带目录名的 host 一律拒绝（附件区保持原文，其余带上自己的主机名）。 */
const virtualNotDirectory = (host: string): string =>
  host === ATTACHMENT_HOST
    ? 'The attachment host is not a directory. Address its files with host="attachment" and an absolute path, e.g. /2026-11-16/ab12cd34-chart.png.'
    : `The ${host} host is not a directory. Address its files with host="${host}" and an absolute path, e.g. /<id>/report.md.`;

const stripAt = (raw: string): string =>
  raw.startsWith("@") ? raw.slice(1) : raw;

const blank = (v: string | undefined): boolean =>
  v === undefined || v.trim() === "";

export function createAddressBook(deps: {
  /** 会话可见的目录（含存在时的附件区目录）。 */
  directories: () => readonly Directory[];
  /** 主目录所在的环境：主机命名取它，会话可见的目录里可能没有它（子代理的子集）。 */
  primaryEnvId: () => string | null;
  current: () => Directory;
  envOf: (d: Directory) => ExecEnv | null;
  connectionName: (envId: string) => string | undefined;
}): AddressBook {
  const labelOf = (envId: string): string =>
    hostLabel(envId, {
      primaryEnvId: deps.primaryEnvId(),
      connectionName: deps.connectionName,
    });

  const refOf = (d: Directory): string =>
    directoryRef(labelOf(d.environmentId), d.name);

  const hosts = () => {
    const primary = deps.primaryEnvId();
    // 虚拟主机排在最后：collab 之后才是 attachment
    const rank = (envId: string) =>
      envId === primary
        ? 0
        : envId === COLLAB_ENV_ID
          ? 2
          : envId === ATTACHMENT_ENV_ID
            ? 3
            : 1;
    const groups: {
      label: string;
      envId: string;
      directories: Directory[];
    }[] = [];
    for (const d of deps.directories()) {
      const hit = groups.find((g) => g.envId === d.environmentId);
      if (hit) hit.directories.push(d);
      else
        groups.push({
          label: labelOf(d.environmentId),
          envId: d.environmentId,
          directories: [d],
        });
    }
    // sort 稳定：同一档内保持目录顺序
    return groups.sort((a, b) => rank(a.envId) - rank(b.envId));
  };

  const labels = () => hosts().map((g) => g.label);

  /** 虚拟主机的根（真实路径）：该主机在会话里的那个目录。 */
  const virtualRoot = (envId: string): Directory | undefined =>
    deps.directories().find((d) => d.environmentId === envId);

  /** 会话里的目录清单（不含虚拟主机），报错用。 */
  const refs = () =>
    hosts()
      .filter((g) => VIRTUAL_HOSTS[g.envId] === undefined)
      .flatMap((g) => g.directories.map(refOf))
      .join(", ");

  const requireEnv = (d: Directory): ExecEnv => {
    const env = deps.envOf(d);
    if (!env)
      throw new Error(`Host "${labelOf(d.environmentId)}" is not available.`);
    return env;
  };

  // 虚拟主机内的展示形式：不暴露 Server 的真实路径
  const shownOf = (label: string, env: ExecEnv, p: string): string => {
    if (env.kind !== "virtual") return `${label}:${p}`;
    const root = virtualRoot(env.id)?.path ?? p;
    const rel = pathOf(env).relative(root, p);
    return `${label}:/${rel}`;
  };

  const located = (env: ExecEnv, p: string, fallback?: Directory): Located => {
    const label = labelOf(env.id);
    const own = deps.directories().filter((d) => d.environmentId === env.id);
    const pm = pathOf(env);
    const inside = own
      .filter((d) => isInside(d.path, p, pm))
      .sort((a, b) => b.path.length - a.path.length);
    const cur = deps.current();
    const directory =
      inside[0] ??
      (fallback && fallback.environmentId === env.id ? fallback : undefined) ??
      (own.some((d) => d.id === cur.id) ? cur : undefined) ??
      own[0];
    if (!directory)
      throw new Error(`Host "${label}" has no registered directory.`);
    return {
      host: label,
      shown: shownOf(label, env, p),
      env,
      path: p,
      directory,
    };
  };

  // 主机名（含 server 别名）→ hosts() 里的那一组；大小写不敏感。
  const hostGroup = (name: string) => {
    const lower = name.toLowerCase();
    const group =
      hosts().find((g) => g.label.toLowerCase() === lower) ??
      (lower === SERVER_HOST
        ? hosts().find((g) => g.envId === LOCAL_ENV_ID)
        : undefined);
    if (!group)
      throw new Error(
        `Unknown host "${name}". Hosts in this session: ${labels().join(", ")}.`,
      );
    return group;
  };

  // 路径以「已知主机名 + 冒号」开头：只拒绝，不解析——主机要写进 host 参数。
  const sniffsHost = (p: string): { name: string; rest: string } | null => {
    const i = p.indexOf(":");
    if (i <= 0) return null;
    const name = p.slice(0, i);
    const known = [
      ...new Set([...labels(), SERVER_HOST, ...VIRTUAL_HOST_NAMES]),
    ].map((x) => x.toLowerCase());
    return known.includes(name.toLowerCase())
      ? { name, rest: p.slice(i + 1) }
      : null;
  };

  // `~` 在该主机上展开。
  const expand = async (env: ExecEnv, text: string): Promise<string> =>
    text === "~" || text.startsWith("~/")
      ? pathOf(env).join(await env.homedir(), text.slice(1))
      : text;

  const isTilde = (p: string): boolean => p === "~" || p.startsWith("~/");

  const locate = async (
    host: string | undefined,
    path: string | undefined,
  ): Promise<Located> => {
    const hostText = blank(host) ? "" : (host as string).trim();
    // 空串 / 全空白按「不写」处理
    const pathText = blank(path) ? "" : stripAt(path as string);
    const sniffed = sniffsHost(pathText);
    if (sniffed)
      throw new Error(
        `The path "${pathText}" starts with a host name. Put the host in the host parameter: host="${sniffed.name}", path="${sniffed.rest}".`,
      );

    // 不写 host：相对当前目录，绝对路径在当前目录所在的主机上
    if (hostText === "") {
      const cur = deps.current();
      const curLabel = labelOf(cur.environmentId);
      // 当前目录所在的主机连不上时，别的主机照常可用，所以环境按需取
      const env = requireEnv(cur);
      if (pathText === "")
        return {
          host: curLabel,
          shown: shownOf(curLabel, env, cur.path),
          env,
          path: cur.path,
          directory: cur,
        };
      const pm = pathOf(env);
      const p =
        pm.isAbsolute(pathText) || isTilde(pathText)
          ? await expand(env, pathText)
          : pm.resolve(cur.path, pathText);
      return located(env, p);
    }

    const colon = hostText.indexOf(":");
    const hostName = colon < 0 ? hostText : hostText.slice(0, colon);
    // 按第一个冒号切：目录名里可以再冒号
    const dirName = colon < 0 ? null : hostText.slice(colon + 1);
    const group = hostGroup(hostName);
    const first = group.directories[0] as Directory;

    if (group.envId === COLLAB_ENV_ID || group.envId === ATTACHMENT_ENV_ID) {
      // 虚拟主机：只按 / 开头的路径寻址，`~` 等价于根；越界直接拒绝
      if (dirName !== null) throw new Error(virtualNotDirectory(group.label));
      const env = requireEnv(first);
      if (pathText === "")
        throw new Error(
          group.envId === ATTACHMENT_ENV_ID
            ? "The attachment host needs a path: write an absolute path such as /2026-11-16/ab12cd34-chart.png."
            : `The ${group.label} host needs a path: write an absolute path such as /<id>/report.md.`,
        );
      if (!pathText.startsWith("/") && !isTilde(pathText))
        throw new Error(
          `A relative path on the ${group.label} host is not accepted. Write an absolute path: /${pathText}.`,
        );
      const pm = pathOf(env);
      const rel = isTilde(pathText) ? pathText.slice(1) : pathText;
      const p = rel === "" ? first.path : pm.join(first.path, rel as string);
      if (!isInside(first.path, p, pm))
        throw new Error(
          `Paths on the ${group.label} host must stay inside it: ${shownOf(group.label, env, p)}.`,
        );
      return located(env, p, first);
    }

    const nameExample = `${hostName}:${first.name}`;
    // 冒号后面是路径而不是目录名：用错了，教它怎么写（这里的 <name> 是字面写法，指目录名）
    if (dirName !== null && (dirName.startsWith("/") || isTilde(dirName)))
      throw new Error(
        `"${hostText}" is not a directory name. To use an arbitrary path, pass host="${hostName}" with an absolute path; to use a directory, name it: ${hostName}:<name>. Directories in this session: ${refs()}.`,
      );

    const onHost = group.directories.map(refOf).join(", ");

    // 裸主机：只认绝对路径（目录只决定相对路径的起点，所以必须点名一个目录）
    if (dirName === null || dirName === "") {
      if (pathText === "")
        throw new Error(
          `A host on its own needs a path. Give an absolute path (/… or ~/…), or name a directory in the host parameter, e.g. ${nameExample}. Directories on ${group.label}: ${onHost}.`,
        );
      if (!pathOf(requireEnv(first)).isAbsolute(pathText) && !isTilde(pathText))
        throw new Error(
          `A relative path on host "${group.label}" needs a directory. Write an absolute path (/${pathText} or ~/${pathText}), or name a directory in the host parameter, e.g. ${nameExample}. Directories on ${group.label}: ${onHost}.`,
        );
      const env = requireEnv(first);
      return located(env, await expand(env, pathText));
    }

    // host:目录名：目录决定相对路径的起点与归属，绝对路径仍可写出目录之外
    const dir = group.directories.find((d) => d.name === dirName);
    if (!dir)
      throw new Error(
        `Directory "${hostText}" not found. Directories in this session: ${refs()}.`,
      );
    const env = requireEnv(dir);
    if (pathText === "")
      return {
        host: labelOf(env.id),
        shown: shownOf(labelOf(env.id), env, dir.path),
        env,
        path: dir.path,
        directory: dir,
      };
    const pm = pathOf(env);
    const p =
      pm.isAbsolute(pathText) || isTilde(pathText)
        ? await expand(env, pathText)
        : pm.resolve(dir.path, pathText);
    return located(env, p, dir);
  };

  const directory = (ref: string): Directory => {
    const text = (ref ?? "").trim();
    const colon = text.indexOf(":");
    if (colon < 0)
      throw new Error(
        `A directory is written <host>:<name>, for example local:proj. Directories in this session: ${refs()}.`,
      );
    const group = hostGroup(text.slice(0, colon));
    const virtual = VIRTUAL_HOSTS[group.envId];
    if (virtual !== undefined) throw new Error(virtualNotDirectory(virtual));
    const hit = group.directories.find((d) => d.name === text.slice(colon + 1));
    if (!hit)
      throw new Error(
        `Directory "${text}" not found. Directories in this session: ${refs()}.`,
      );
    return hit;
  };

  return { hosts, labelOf, refOf, directory, locate };
}
