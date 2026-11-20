// 仅测试用：用真的地址簿（session/address.ts）驱动，只把目录与环境当夹具给进去。

import type { ExecEnv } from "../env/types.js";
import type { Directory } from "../store/directories.js";
import { createAddressBook, type Located } from "./address.js";

export function makeAddressBook(o: {
  dirs: Directory[];
  currentId: string;
  /** 主目录 id（它所在的环境就是 local 主机）。 */
  primaryId: string;
  envOf: (d: Directory) => ExecEnv | null;
  connectionName?: (envId: string) => string | undefined;
}): {
  locate: (
    host: string | undefined,
    path: string | undefined,
  ) => Promise<Located>;
  directory: (ref: string) => Directory;
  refOf: (d: Directory) => string;
} {
  const book = createAddressBook({
    directories: () => o.dirs,
    primaryEnvId: () =>
      o.dirs.find((d) => d.id === o.primaryId)?.environmentId ?? null,
    current: () => {
      const hit = o.dirs.find((d) => d.id === o.currentId);
      if (!hit) throw new Error("no current directory");
      return hit;
    },
    envOf: o.envOf,
    connectionName: o.connectionName ?? (() => undefined),
  });
  return {
    locate: (host, path) => book.locate(host, path),
    directory: (ref) => book.directory(ref),
    refOf: (d) => book.refOf(d),
  };
}
