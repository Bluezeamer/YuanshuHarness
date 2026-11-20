// 把目录树走成 zip 条目序列：经环境原语读，不跟随符号链接，也不在远端起 zip 进程。

import type { ZipEntry } from "../lib/zip-stream.js";
import { pathOf } from "../permission/paths.js";
import type { ExecEnv } from "./types.js";

/** 目录打成一个 zip：条目名带根目录名前缀，同一目录内按名字排序，链接与非常规文件跳过。 */
export async function* archiveEntries(
  env: ExecEnv,
  root: string,
): AsyncGenerator<ZipEntry> {
  const pm = pathOf(env);
  // 根是文件系统根时 basename 为空，退回用 root 本身当前缀
  const prefix = pm.basename(root) || root;
  // 根本身跟随链接（接口已按 stat 判定它是目录）；树内一律不跟随
  const st = await env.stat(root);
  if (!st?.isDirectory) return;
  yield {
    name: prefix,
    dir: true,
    mtimeMs: st.mtimeMs,
    mode: st.mode & 0o7777,
  };
  yield* walk(env, root, prefix);
}

async function* walk(
  env: ExecEnv,
  dir: string,
  name: string,
): AsyncGenerator<ZipEntry> {
  const pm = pathOf(env);
  // 前缀是文件系统根（"/" 或 "/c"）时末尾已带分隔符，别拼成两个
  const child = (c: string) => `${name.endsWith("/") ? name : `${name}/`}${c}`;
  const names = (await env.readdir(dir))
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const c of names) {
    const full = pm.join(dir, c);
    const childName = child(c);
    // lstat 不跟随链接：链接既不是目录也不是文件，下面两支都不进，自然跳过；lstat 失败（列目录后刚被删）同理
    const st = await env.lstat(full);
    if (!st) continue;
    if (st.isDirectory) {
      yield {
        name: childName,
        dir: true,
        mtimeMs: st.mtimeMs,
        mode: st.mode & 0o7777,
      };
      yield* walk(env, full, childName);
    } else if (st.isFile) {
      yield {
        name: childName,
        size: st.size,
        mtimeMs: st.mtimeMs,
        mode: st.mode & 0o7777,
        open: () => env.readStream(full),
      };
    }
  }
}
