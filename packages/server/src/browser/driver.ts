// 浏览器驱动的最小接口：manager 只依赖它，单测用替身，真实实现见 chromium.ts。

export interface PageDriver {
  /** 导航并等到加载完成；失败抛 Error（信息直接给模型看）。 */
  goto(url: string): Promise<{ status: number | null }>;
  url(): string;
  title(): Promise<string>;
  loading(): boolean;
  /** 带编号的文本快照（已格式化）。 */
  snapshot(): Promise<string>;
  click(ref: number): Promise<void>;
  type(ref: number, text: string, submit: boolean): Promise<void>;
  /** JPEG 截图。 */
  screenshot(): Promise<Buffer>;
  startScreencast(onFrame: (jpeg: Buffer) => void): Promise<void>;
  stopScreencast(): Promise<void>;
  /** 导航、加载状态变化时回调。 */
  onChange(cb: () => void): void;
  /** 取走自上次以来被拦截的主框架跳转（未获批准的站点）。 */
  takeBlocked(): string[];
  close(): Promise<void>;
}

export interface BrowserDriver {
  /**
   * 新开一个隔离的浏览上下文和一个页面。navAllowed 决定主框架可以跳转到哪些地址，
   * 每次跳转请求即时调用。
   */
  newPage(navAllowed: (url: string) => boolean): Promise<PageDriver>;
  close(): Promise<void>;
  /** 浏览器进程意外退出时回调。 */
  onDisconnected(cb: () => void): void;
}

export type Launcher = () => Promise<BrowserDriver>;

// 视口固定：侧边 pane 按比例缩放显示。
export const VIEWPORT = { width: 1280, height: 800 } as const;
