// 画面区：画布常驻（页面流往里画，隐藏时也要在），其上按状态盖说明层；手动操作且是操作窗口时才接鼠标键盘。
import { type RefObject, useEffect, useRef } from "react";
import {
  Button,
  Chip,
  Empty,
  IconButton,
  InlineNotice,
  Loading,
  toast,
} from "../../../../ui";
import { copyText } from "../../../../ui/clipboard";
import { CloseIcon } from "../../../../ui/icons";
import {
  type EngineState,
  type PageStreamState,
  type PageView,
  type StreamSend,
  useInputCapture,
} from "../../browser";
import { clipPreview } from "./model";

/** 流里的错误提示（输入被拒、导航被拒）多久自动消失。 */
const NOTICE_MS = 6000;

export interface StageProps {
  page: PageView | null;
  engine: EngineState | null;
  stream: PageStreamState;
  send: StreamSend;
  canvas: RefObject<HTMLCanvasElement | null>;
  /** 休眠页的缩略图（object URL） */
  thumb: string | null;
  /** 观察态左下角的小标：在用这个页面的会话名 */
  tag: string | null;
  onRetryStream(): void;
  onRetryEngine(): void;
  onOpenAddress(): void;
  onClearNotice(): void;
  /** 回放盖在上面时藏起来：画布仍挂着、继续接画面，回来时是最新的 */
  hidden?: boolean;
}

export function Stage(p: StageProps) {
  const { page, stream, send } = p;
  const view = useRef<HTMLDivElement>(null);
  const manual = page?.controller === "user";
  const live = stream.link === "live";
  // 观察态吞掉鼠标键盘：只有手动操作、本窗口是操作窗口、页面醒着、连接正常才转发输入。
  const capture = manual && stream.operator && page?.state === "active" && live;
  const ime = useRef<HTMLTextAreaElement>(null);
  useInputCapture(view, capture, send.input, ime, send.copy);

  // 页面里选中的文字回来了：写进本机剪贴板（没选中就什么都不做）
  const copiedSeq = stream.copied?.seq;
  const copiedText = stream.copied?.text ?? "";
  useEffect(() => {
    if (copiedSeq === undefined || copiedText === "") return;
    void copyText(copiedText).then((ok) =>
      toast(ok ? "已复制" : "无法写入剪贴板", { tone: ok ? "ok" : "warn" }),
    );
  }, [copiedSeq, copiedText]);

  // 页面自己写了剪贴板（分享 / 复制按钮）：同样写进本机剪贴板，并让用户看到复制了什么
  const pageCopySeq = stream.pageCopy?.seq;
  const pageCopyText = stream.pageCopy?.text ?? "";
  useEffect(() => {
    if (pageCopySeq === undefined || pageCopyText === "") return;
    void copyText(pageCopyText).then((ok) =>
      toast(
        ok
          ? `页面复制了：${clipPreview(pageCopyText)}`
          : "页面复制了内容，但无法写入本机剪贴板",
        { tone: ok ? "ok" : "warn" },
      ),
    );
  }, [pageCopySeq, pageCopyText]);

  const seq = stream.notice?.seq;
  const { onClearNotice } = p;
  useEffect(() => {
    if (seq === undefined) return;
    const timer = setTimeout(onClearNotice, NOTICE_MS);
    return () => clearTimeout(timer);
  }, [seq, onClearNotice]);

  const showCanvas =
    page?.state === "active" && (live || stream.link === "reconnecting");
  const takeover = manual && !stream.operator && live;

  return (
    <div className="ws-wb-stage" hidden={p.hidden}>
      <div
        ref={view}
        className="ws-wb-view"
        data-manual={manual || undefined}
        tabIndex={capture ? 0 : -1}
      >
        {/* 输入法的落脚点：看不见，只为让焦点落在可编辑元素上；见 useInputCapture */}
        <textarea
          ref={ime}
          className="ws-wb-ime"
          aria-label="向页面输入文字"
          tabIndex={-1}
          rows={1}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
        />
        <canvas
          ref={p.canvas}
          hidden={!showCanvas}
          className="ws-wb-canvas"
          aria-label={page?.title || "页面画面"}
        />
        <Veil {...p} />
        {p.tag && !manual && showCanvas && (
          <Chip className="ws-wb-tag">{p.tag} · 操作中</Chip>
        )}
        {(takeover || stream.notice) && (
          <div className="ws-wb-float">
            {takeover && (
              <div className="ws-wb-float-row">
                <InlineNotice tone="warn">
                  另一个窗口正在操作这个页面
                </InlineNotice>
                <Button size="sm" onClick={send.take}>
                  接管操作
                </Button>
              </div>
            )}
            {stream.notice && (
              <div className="ws-wb-float-row">
                <InlineNotice tone="warn">{stream.notice.text}</InlineNotice>
                <IconButton
                  size="sm"
                  label="关闭提示"
                  icon={<CloseIcon size={12} />}
                  onClick={p.onClearNotice}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 画面上盖的说明：没有页面、休眠、连接中 / 断开 / 页面已关；有画面时返回 null（重连时盖一层半透明）。 */
function Veil({
  page,
  engine,
  stream,
  thumb,
  onRetryStream,
  onRetryEngine,
  onOpenAddress,
}: StageProps) {
  if (!page)
    return (
      <NoPage
        engine={engine}
        onRetryEngine={onRetryEngine}
        onOpenAddress={onOpenAddress}
      />
    );
  if (page.state === "sleeping")
    return (
      <div className="ws-wb-veil">
        {thumb && <img className="ws-wb-thumb" src={thumb} alt="" />}
        <span className="t-entry">页面休眠中</span>
        <span className="t-aux">
          为省内存休眠了；点工具条上的「唤醒」继续。
        </span>
      </div>
    );
  switch (stream.link) {
    case "connecting":
      return (
        <div className="ws-wb-veil">
          <Loading>正在连接页面…</Loading>
        </div>
      );
    case "reconnecting":
      return (
        <div className="ws-wb-veil" data-soft role="status">
          <span className="t-aux">连接已断开，重连中…</span>
        </div>
      );
    case "lost":
      return (
        <div className="ws-wb-veil" data-tone="danger">
          <Empty
            tone="danger"
            title="连接已断开"
            description="连不上这个页面的画面流"
            action={
              <Button size="sm" onClick={onRetryStream}>
                重试
              </Button>
            }
          />
        </div>
      );
    case "closed":
      return (
        <div className="ws-wb-veil">
          <span className="t-aux">页面已关闭</span>
        </div>
      );
    default:
      return null;
  }
}

function NoPage({
  engine,
  onRetryEngine,
  onOpenAddress,
}: Pick<StageProps, "engine" | "onRetryEngine" | "onOpenAddress">) {
  if (engine?.status === "failed")
    return (
      <div className="ws-wb-veil">
        <Empty
          tone="danger"
          title="浏览器不可用"
          description={
            <>
              {engine.problem?.message ?? "浏览器引擎没有启动成功"}
              {engine.problem?.fix && (
                <code className="t-mono ws-wb-fix">{engine.problem.fix}</code>
              )}
            </>
          }
          action={
            <Button size="sm" onClick={onRetryEngine}>
              重试
            </Button>
          }
        />
      </div>
    );
  if (engine?.status === "installing" || engine?.status === "starting")
    return (
      <div className="ws-wb-veil">
        <Loading>
          {engine.status === "installing"
            ? "正在下载浏览器（首次使用，约 200MB）…"
            : "正在启动浏览器…"}
        </Loading>
      </div>
    );
  return (
    <div className="ws-wb-veil">
      <Empty
        title="还没有页面"
        description="agent 调用浏览器工具时页面会自动出现在这里，也可以自己打开一个地址。"
        action={
          <Button size="sm" onClick={onOpenAddress}>
            打开地址
          </Button>
        }
      />
    </div>
  );
}
