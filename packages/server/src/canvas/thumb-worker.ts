// 缩略图 worker：光子 WASM 是同步的，在主线程跑会堵住整个 Server 的事件循环（所有 WS 与请求），
// 所以解码、缩放与编码都放这里；字节用 transfer 传，不走 base64。
import { parentPort } from "node:worker_threads";
import { resizeImage } from "@earendil-works/pi-coding-agent";

/** 编码后（base64）的大小上限：PNG 压不到它以内才改用 JPEG，再不行才缩小尺寸。 */
const MAX_BYTES = 2 * 1024 * 1024;

interface Job {
  id: number;
  bytes: Uint8Array;
  mime: string;
  maxSide: number;
  quality: number;
}

const port = parentPort;
if (!port) throw new Error("thumb worker requires parentPort");

port.on("message", (job: Job) => {
  void (async () => {
    const out = await resizeImage(job.bytes, job.mime, {
      maxWidth: job.maxSide,
      maxHeight: job.maxSide,
      maxBytes: MAX_BYTES,
      jpegQuality: job.quality,
    }).catch(() => null);
    if (out === null) {
      // WASM 不可用或压不到上限：由主线程决定回退原图还是报太大。
      port.postMessage({ id: job.id, ok: false });
      return;
    }
    // 复制成独占的 buffer，才能整体 transfer 回去。
    const data = new Uint8Array(Buffer.from(out.data, "base64"));
    port.postMessage({ id: job.id, ok: true, data, mime: out.mimeType }, [
      data.buffer,
    ]);
  })();
});
