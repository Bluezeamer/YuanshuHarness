// 画面推送：原生 CDP Page.startScreencast（Playwright 包装的 fps 选项实测无效）。
// 限帧靠「ack 放慢」：每帧等 onFrame 结束、且离上一次 ack 至少 1/maxFps 秒再 ack，Chrome 在 ack 之前不发下一帧，
// 期间的变化合并成最新一帧，所以静止页面的最后一次变化一定会送到。
// 帧一到就交给 onFrame，只有 ack 排队：把交付也排在 ack 间隔后面，发出去的全是过期画面（实测点击到出画翻倍）。
// 不能用 everyNthFrame：它数的是合成器帧，页面静止时合成器不出帧，最后几次变化会被一直扣着。
import type { BrowserContext, CDPSession, Page } from "playwright-core";

export interface ScreencastOptions {
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  quality: number;
}

export interface Screencast {
  stop(): Promise<void>;
}

const noop = () => {};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startScreencast(
  ctx: BrowserContext,
  page: Page,
  opts: ScreencastOptions,
  onFrame: (jpeg: Buffer) => void | Promise<void>,
): Promise<Screencast> {
  const cdp: CDPSession = await ctx.newCDPSession(page);
  let stopped = false;
  const minGapMs = 1000 / Math.max(1, opts.maxFps);
  let lastAckAt = 0;
  // ack 串行：一帧处理完、且离上一次 ack 够久才发。
  let pending: Promise<void> = Promise.resolve();

  cdp.on("Page.screencastFrame", (f) => {
    if (stopped) return;
    const data = f.data;
    const delivered = Promise.resolve()
      .then(() => onFrame(Buffer.from(data, "base64")))
      // 上游（WebSocket）断了：这一帧丢掉，不打断后续帧
      .catch(noop);
    pending = pending.then(async () => {
      await delivered;
      if (stopped) return;
      // Chrome 允许同时有几帧未 ack，所以限的是 ack 的间隔，不是帧到达的间隔
      const wait = lastAckAt + minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      if (stopped) return;
      lastAckAt = Date.now();
      await cdp
        .send("Page.screencastFrameAck", { sessionId: f.sessionId })
        .catch(noop);
    });
  });

  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: opts.quality,
    maxWidth: opts.maxWidth,
    maxHeight: opts.maxHeight,
    everyNthFrame: 1,
  });

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      await cdp.send("Page.stopScreencast").catch(noop);
      await pending.catch(noop);
      await cdp.detach().catch(noop);
    },
  };
}
