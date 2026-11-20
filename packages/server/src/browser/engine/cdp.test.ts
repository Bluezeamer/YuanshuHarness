// PageCdp：会话只建一次并复用、页面关闭后丢弃、报错取第一行、方法与参数原样透传。
// 全部用替身：不装浏览器、不起进程。
import { describe, expect, test } from "vitest";
import { PageCdp } from "./cdp.js";

interface Sent {
  method: string;
  params?: Record<string, unknown>;
}

/** 假页面与假 CDP 会话：记下发出的命令，可预设抛错。 */
function fakePage(opts: { fail?: string; sessionFail?: string } = {}) {
  const listeners = new Map<string, (() => void)[]>();
  const sent: Sent[] = [];
  let sessions = 0;
  let detached = 0;
  const session = {
    async send(method: string, params?: Record<string, unknown>) {
      sent.push({ method, ...(params === undefined ? {} : { params }) });
      if (opts.fail) throw new Error(opts.fail);
      return { ok: method };
    },
    async detach() {
      detached++;
    },
  };
  const page = {
    context: () => ({
      newCDPSession: async () => {
        sessions++;
        if (opts.sessionFail) throw new Error(opts.sessionFail);
        return session;
      },
    }),
    on: (name: string, cb: () => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), cb]);
    },
  };
  return {
    page,
    sent,
    get sessions() {
      return sessions;
    },
    get detached() {
      return detached;
    },
    close() {
      for (const cb of listeners.get("close") ?? []) cb();
    },
  };
}

const asPage = (p: ReturnType<typeof fakePage>) => p.page as never;

describe("PageCdp", () => {
  test("多次 send 只建一个会话，方法与参数原样透传", async () => {
    const fake = fakePage();
    const cdp = new PageCdp(asPage(fake));
    expect(await cdp.send("Runtime.evaluate", { expression: "1" })).toEqual({
      ok: "Runtime.evaluate",
    });
    await cdp.send("Page.getNavigationHistory");
    expect(fake.sessions).toBe(1);
    expect(fake.sent).toEqual([
      { method: "Runtime.evaluate", params: { expression: "1" } },
      { method: "Page.getNavigationHistory" },
    ]);
  });

  test("CDP 报错取第一行", async () => {
    const fake = fakePage({
      fail: "'Foo.bar' wasn't found\n  at module\n  more",
    });
    const cdp = new PageCdp(asPage(fake));
    const err = (await cdp.send("Foo.bar").catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("'Foo.bar' wasn't found");
  });

  test("页面关闭之后丢弃会话，再 send 报页面已关闭", async () => {
    const fake = fakePage();
    const cdp = new PageCdp(asPage(fake));
    await cdp.send("Runtime.evaluate");
    expect(fake.sessions).toBe(1);
    fake.close();
    await Promise.resolve();
    expect(fake.detached).toBe(1);
    await expect(cdp.send("Runtime.evaluate")).rejects.toThrow(/页面已关闭/);
    expect(fake.sessions).toBe(1);
  });

  test("建会话失败时错误原样抛出，下次再试", async () => {
    const fake = fakePage({ sessionFail: "Target closed" });
    const cdp = new PageCdp(asPage(fake));
    await expect(cdp.send("Runtime.evaluate")).rejects.toThrow("Target closed");
    expect(fake.sessions).toBe(1);
  });
});
