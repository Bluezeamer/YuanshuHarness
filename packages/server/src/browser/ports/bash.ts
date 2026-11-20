// 把 bash 的输出接进端口发现：输出原样透传，只顺带喂一份给扫描器。
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { createPortScanner } from "./scan.js";

/** 每次 exec 一个新的扫描器：不同命令的行不能串到一起。 */
export function scanBashOperations(
  ops: BashOperations,
  onPort: (port: number) => void,
): BashOperations {
  return {
    exec: async (command, cwd, o) => {
      const scanner = createPortScanner(onPort);
      return await ops.exec(command, cwd, {
        ...o,
        onData: (d) => {
          scanner.push(d);
          o.onData(d);
        },
      });
    },
  };
}
