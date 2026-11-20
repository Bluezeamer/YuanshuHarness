// 页面级 CDP 会话：每页一个，懒建、长存。
// Emulation / Network 域的覆盖跟着会话走，会话一 detach 覆盖就失效（整页导航之后还在），
// 所以不能用完就丢；页面关闭时才丢弃。
import type { CDPSession, Page } from "playwright-core";
import { firstLine } from "./assets.js";

const noop = () => {};

export class PageCdp {
  private session: CDPSession | null = null;
  private closed = false;

  constructor(private readonly page: Page) {
    page.on("close", () => {
      this.closed = true;
      const session = this.session;
      this.session = null;
      void session?.detach().catch(noop);
    });
  }

  /** 发一条 CDP 命令；失败抛 Error（message 是 CDP 报错的第一行）。 */
  async send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const session = await this.open();
    // CDP 的方法名是运行期才知道的字符串，Playwright 的类型签名只认字面量联合。
    const send = session.send as unknown as (
      m: string,
      p?: Record<string, unknown>,
    ) => Promise<unknown>;
    try {
      return await send.call(session, method, params);
    } catch (err) {
      // CDP 的原文常带多行说明：取第一行（Playwright 会在前面套 `cdpSession.send: Protocol error (…)`）。
      throw new Error(firstLine(err));
    }
  }

  private async open(): Promise<CDPSession> {
    if (this.session) return this.session;
    if (this.closed) throw new Error("页面已关闭，CDP 会话不可用");
    this.session = await this.page.context().newCDPSession(this.page);
    return this.session;
  }
}
