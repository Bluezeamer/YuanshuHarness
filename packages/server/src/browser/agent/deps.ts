// agent 浏览器工具要的全部注入依赖：接线（session/extensions.ts）一处填，各工具文件只读。
import type { DownloadWindows } from "../downloads/windows.js";
import type { TargetOptions } from "../net/target.js";
import type { PageRegistry } from "../pages/registry.js";
import type { AccessState } from "./access.js";
import type {
  createApproveDownload,
  createApproveUpload,
  Verdict,
} from "./approve.js";
import type { Cleaner } from "./clean/types.js";
import type { AskFn } from "./handoff.js";
import type { ResolvedUpload } from "./upload.js";

export interface BrowserToolsDeps {
  registry: PageRegistry;
  cleaner: Cleaner;
  /** 解析目标所需：主机名 → 环境 id、不写主机的绝对路径落在哪个环境 */
  targetOptions(): TargetOptions;
  /** 当前会话所属的工作区键；没有工作区的会话返回只属于它的键 */
  workspaceKey(): string;
  /**
   * 打开前的审批：allowed 表示放行（已批准或用户刚批准），被拒时 note 是用户写的理由。
   * ask 的实现由 S5 用权限层包出来。
   * **批准后要由实现把站点记进 `access.approved` 能查到的地方**：工具层不记，否则同一站点每次都问。
   */
  approveOpen(args: {
    origin: string;
    reason: string;
    service?: boolean;
  }): Promise<Verdict>;
  access: AccessState;
  /** 接管提问用 */
  ask: AskFn;
  /**
   * 向本工作区在线的界面发展示提示；返回送达的界面个数（0 = 没有在线的界面）。
   * 只投给此刻订阅着的界面，不留存、不重放。
   */
  show(args: {
    pageId: string;
    title: string;
    url: string;
    note: string;
  }): number;
  /** 写审计；本片只调用，不实现 */
  audit?(entry: { tool: string; pageId?: string; summary: string }): void;
  /** 下载窗口：agent 一次动作期间收下载，窗口外的取消。 */
  downloads: DownloadWindows;
  /** 下载前的审批（默认每次问，没有「记住」）。 */
  approveDownload: ReturnType<typeof createApproveDownload>;
  /** 流式存下载（AttachmentDirectories.saveFrom 一类），返回 `[attach_file]` 标记行与大小。 */
  saveFile(args: {
    sessionId: string;
    name: string;
    write(abs: string): Promise<void>;
  }): Promise<{ marker: string; size: number; sizeText: string }>;
  /** 单个文件大小上限（字节），下载与上传共用：沿用设置里的 uploadMaxMB。 */
  fileMaxBytes(): number;
  /** 解析一个来源文件（host + path）并守硬边界（位置解析在接线处注入）。 */
  resolveUpload(
    host: string | undefined,
    path: string,
  ): Promise<ResolvedUpload>;
  /** 上传前的审批（每次问，没有「记住」；完全允许档或工具规则放行时不过卡片）。 */
  approveUpload: ReturnType<typeof createApproveUpload>;
  /** 记一步回放（动作之后的画面）；调用方是 browser.replay.record。 */
  recordStep?(args: {
    sessionId: string;
    workspaceKey: string;
    pageId: string;
    tool: string;
    summary: string;
  }): Promise<void>;
  /**
   * 高敏感站点（邮箱、云控制台、支付、代码托管…，见 `isHighValueHost`）上的每个动作都要用户确认：
   * 调用方弹卡片并把审批结果交回来（被拒时带用户写的理由）。不提供就不确认；完全允许档要不要跳过由调用方定。
   */
  confirmAction?(args: {
    tool: string;
    host: string;
    summary: string;
  }): Promise<Verdict>;
  /**
   * 把字节存成本会话的附件，返回 `[attach_file]` 标记行（session/attachments 的 attachmentLine）；
   * 调用方是 AttachmentDirectories.save。
   */
  saveAsset(args: {
    sessionId: string;
    name: string;
    bytes: Buffer;
  }): Promise<{ marker: string }>;
  /**
   * 变量遮罩：工具结果的文字由扩展统一遮，落成附件的文字没有，所以落文件前要自己过一遍。
   */
  mask(text: string): string;
  /**
   * 给模型的图片：按设置页的图片压缩参数处理（与用户粘贴的图片同一套），返回不带前缀的 base64。
   * width / height 是交给模型的尺寸；回退原图时不给（调用方自己知道原图尺寸）。
   */
  modelImage(
    bytes: Buffer,
    mime: string,
  ): Promise<{
    mimeType: string;
    data: string;
    width?: number;
    height?: number;
  }>;
}
