// 仅测试用：用一个固定的 Where 造单目录的位置解析，让大批旧测试少改夹具。
// host 只认 local / server / attachment（别的主机名按未知拒绝），目录名不认；
// 真实规则本身由 session/address.test.ts 与 permission/address-gate.test.ts 专门覆盖。
import path from "node:path";
import { LocalEnv } from "../env/local.js";
import type { DirectoryCtx, Located } from "./extension.js";
import type { PathEnv } from "./paths.js";
import type { Tier } from "./tier.js";

/** 造一个单目录的判定上下文（cwd 是它的目录，记住的规则收到 added 里）。 */
export function ctxAt(
  cwd: string,
  o: {
    name?: string;
    env?: PathEnv;
    tier?: Tier;
    rules?: DirectoryCtx["rules"];
    added?: unknown[];
    /** 引用写法 `<host>:<name>`；缺省 local:<name>。 */
    ref?: string;
  } = {},
): DirectoryCtx {
  const name = o.name ?? "proj";
  return {
    id: `id-${name}`,
    name,
    ref: o.ref ?? `local:${name}`,
    where: { env: o.env ?? (new LocalEnv() as PathEnv), cwd },
    tier: o.tier ?? "rules",
    rules: o.rules ?? { path: [], command: [] },
    addRule: (r) => o.added?.push(r),
  };
}

/**
 * 命令类工具（bash）的判定上下文：单目录；缺省或 `local` / `local:<name>` 都是它自己，
 * 别的主机名、别的目录名与裸主机一律按地址簿的报错拒绝。
 */
export function dirAt(
  cwd: string,
  o: Parameters<typeof ctxAt>[1] = {},
): (host: string | undefined) => Promise<DirectoryCtx> {
  const ctx = ctxAt(cwd, o);
  return async (ref) => {
    const text = (ref ?? "").trim();
    if (text === "") return ctx;
    const colon = text.indexOf(":");
    const host = colon < 0 ? text : text.slice(0, colon);
    if (!["local", "server"].includes(host.toLowerCase()))
      throw new Error(`Unknown host "${host}".`);
    if (colon < 0)
      throw new Error(
        "A directory is written <host>:<name>, for example local:proj. Directories in this session: local:proj.",
      );
    if (text.slice(colon + 1) !== ctx.name)
      throw new Error(
        `Directory "${text}" not found. Directories in this session: ${ctx.ref}.`,
      );
    return ctx;
  };
}

/** 单目录的 locate：缺省/空串 = cwd，相对路径按 cwd，绝对路径与 `~` 按绝对路径。 */
export function locateAt(
  cwd: string,
  o: Parameters<typeof ctxAt>[1] = {},
): (host: string | undefined, path: string | undefined) => Promise<Located> {
  const ctx = ctxAt(cwd, o);
  const virtual = ctx.where.env.kind === "virtual";
  // 虚拟环境按它的 id 取主机名（附件区 attachment、协作区 collab）
  const host = virtual ? (ctx.where.env as { id: string }).id : "local";
  const pm = path;
  return async (askedHost, askedPath) => {
    const name = (askedHost ?? "").trim();
    if (name !== "" && !["local", "server", host].includes(name.toLowerCase()))
      throw new Error(`Unknown host "${name}".`);
    const text = (askedPath ?? "").replace(/^@/, "");
    const base = (p: string): Located => ({
      host: name === "" ? host : name.toLowerCase(),
      shown: virtual ? `${host}:/${pm.relative(cwd, p)}` : `${host}:${p}`,
      env: ctx.where.env,
      path: p,
      ctx,
    });
    if (text === "") return base(cwd);
    // `file://` 这类前缀在真实解析里属于「无法可靠解析」，这里也交给 resolveTarget 判成无法解析
    if (text.startsWith("file://")) return base(text);
    if (text === "~" || text.startsWith("~/"))
      return base(pm.join(await ctx.where.env.homedir(), text.slice(1)));
    return base(pm.resolve(cwd, text));
  };
}
