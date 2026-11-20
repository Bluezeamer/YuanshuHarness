// 把一个 Server 本机的暂存文件交付到工作区某个目录的根下：取名、防重名、排他创建、失败不留半截。
// 写法照 env/transfer.ts 的 copyOne：不覆盖、按目标环境的路径方言拼路径、写入走 ExecEnv（可能是 ssh 远端）。

import { once } from "node:events";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { ExecEnv } from "../../env/types.js";
import { pathOf } from "../../permission/paths.js";
import type { Directory } from "../../store/directories.js";

// 重名最多试到 `名字 (99).扩展名`，再多说明这个目录该清理了。
const MAX_INDEX = 99;
// 清洗后什么都不剩时的兜底名。
const FALLBACK_NAME = "download";

/**
 * 把暂存文件流式写到 dir.path 的根下：文件名取 basename（按目标环境的路径方言，`pathOf(env)`），
 * 去掉 NUL 与控制字符，清洗后为空用 "download"；重名依次试 `<stem> (1).<ext>`、`(2)`……最多 99 次，都占了抛 Error（一行中文）。
 * 先 env.lstat 判存在，再 writeStream(…, { exclusive: true, mode: 0o644 }) 防并发；排他创建失败按「已存在」换下一个名字，其余错误原样抛。
 * 写入中途失败：删掉已写的半截文件再抛。返回最终文件名与完整路径。
 */
export async function putIntoDirectory(
  env: ExecEnv,
  dir: Directory,
  staged: { filename: string; path: string },
): Promise<{ name: string; path: string }> {
  const pm = pathOf(env);
  const clean = cleanName(pm.basename(staged.filename));
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";

  for (let n = 0; n <= MAX_INDEX; n++) {
    const name = n === 0 ? clean : `${stem} (${n})${ext}`;
    const target = pm.join(dir.path, name);
    if (await env.lstat(target)) continue;
    let out: Awaited<ReturnType<ExecEnv["writeStream"]>> | null = null;
    try {
      out = await env.writeStream(target, { exclusive: true, mode: 0o644 });
    } catch (err) {
      // 刚才没有、排他创建却失败：文件已存在就是别人抢先建了，换下一个名字；其余（没权限、盘满）原样抛。
      if (await env.lstat(target)) continue;
      throw err;
    }
    try {
      await pipeline(createReadStream(staged.path), out);
      // sftp 写流在 finish 时句柄可能尚未关闭，等 close 再返回
      if (!out.closed) await once(out, "close");
      return { name, path: target };
    } catch (err) {
      // 写入中途失败：target 是本次排他创建的，删掉半截文件再抛。
      out.destroy();
      await env.remove(target).catch(noop);
      throw err;
    }
  }
  throw new Error(
    `这个目录里已经有 ${MAX_INDEX + 1} 个同名文件了，换个目录或先清理：${dir.path}`,
  );
}

/** 去掉 NUL 与控制字符；洗完什么都不剩就用兜底名。 */
function cleanName(base: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 这里就是要匹配控制字符
  const name = base.replace(/[\u0000-\u001f\u007f]/g, "");
  return name === "" ? FALLBACK_NAME : name;
}

const noop = () => {};
