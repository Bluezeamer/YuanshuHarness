// 「这个端口此刻有没有在监听」：经环境原语连一下，连上就关。只用来给前端列端口，不传数据。
import type { Duplex } from "node:stream";
import type { ExecEnv } from "../../env/types.js";

/** 连不上一般就是没人在听，等太久没意义。 */
const DEFAULT_TIMEOUT_MS = 800;

/** 这个环境上的端口此刻有没有在监听：连上就关；超时、失败、环境没有 openTcp 都是 false。 */
export async function isListening(
  env: Pick<ExecEnv, "openTcp"> | null,
  port: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  const open = env?.openTcp;
  if (!open) return false;
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(ok);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    const connected = (stream: Duplex) => {
      // 超时之后才连上的也要关掉，不泄露套接字。
      stream.destroy();
      finish(true);
    };
    try {
      open.call(env, port).then(connected, () => finish(false));
    } catch {
      finish(false);
    }
  });
}
