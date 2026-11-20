// 对话流里的 markdown 图片：按 file:<主机>:<路径> / 相对路径解析到 directory 文件，
// 带鉴权取回 blob 显示；点击复用现有图片查看器放大。
import { useEffect, useState } from "react";
import { attachmentBlob } from "../../api/attachments";
import { canvasImageUrl } from "../../api/canvas";
import { readBlob } from "../../api/files";
import { loadToken } from "../../api/http";
import { Button, ImageViewer } from "../../ui";
import {
  ATTACHMENT_ENV,
  canvasRelOf,
  type ImageBase,
  RefError,
  resolveImageTarget,
} from "./imageRef";
import { useSessionId } from "./session";

type State =
  | { status: "loading" }
  | { status: "ready"; url: string; name: string }
  | { status: "error"; reason: string };

const nameOf = (path: string) => path.split("/").pop() || "图片";

const READ_FAILURES = {
  not_found: "文件不存在",
  forbidden: "没有权限读取",
  unauthorized: "登录已失效",
  too_large: "文件太大",
  conflict: "文件正被占用",
  network: "网络错误",
  server: "读取失败",
} as const;

/** 取回图片内容；解析不了或读不到就抛 RefError（message 显示在占位里） */
async function fetchImage(
  src: string,
  sessionId: string | undefined,
  base: ImageBase | undefined,
): Promise<{ blob: Blob; name: string }> {
  if (base?.kind === "canvas") {
    const rel = canvasRelOf(src, base.note);
    if (rel !== null) {
      const res = await fetch(
        canvasImageUrl(base.env, base.project, rel, undefined, ""),
      );
      if (!res.ok) throw new Error(String(res.status));
      return { blob: await res.blob(), name: nameOf(rel) };
    }
  }
  const target = await resolveImageTarget(
    src,
    sessionId,
    base?.kind === "file" ? base : undefined,
  );
  if (target.env === ATTACHMENT_ENV) {
    if (!sessionId) throw new RefError("没有会话，读不到附件区");
    const a = await attachmentBlob(loadToken(), sessionId, `.${target.path}`);
    if (!a.ok) throw new RefError(a.message);
    return { blob: a.data, name: nameOf(target.path) };
  }
  const r = await readBlob(loadToken(), target.env, target.path);
  if (!r.ok) throw new RefError(READ_FAILURES[r.kind]);
  return { blob: r.data, name: nameOf(target.path) };
}

export function ImageBlock({
  src,
  alt,
  base,
}: {
  src?: string;
  alt?: string;
  /** 相对地址相对于谁；不给就按会话 directory（对话里） */
  base?: ImageBase;
}) {
  const sessionId = useSessionId();
  const [state, setState] = useState<State>({ status: "loading" });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    setState({ status: "loading" });
    const load = async () => {
      const img = await fetchImage(src ?? "", sessionId, base);
      if (!alive) return;
      url = URL.createObjectURL(img.blob);
      setState({ status: "ready", url, name: alt || img.name });
    };
    load().catch((e) => {
      if (alive)
        setState({
          status: "error",
          reason: e instanceof RefError ? e.message : "图片读取失败",
        });
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [src, alt, sessionId, base]);

  if (state.status === "loading")
    return (
      <span className="md-img-note t-aux" data-state="loading" aria-busy="true">
        图片加载中…
      </span>
    );
  if (state.status === "error")
    return (
      <span className="md-img-note t-aux" data-state="fail" title={src}>
        [图片：{alt || src || "无来源"}] {state.reason}
      </span>
    );

  return (
    <>
      <Button
        variant="ghost"
        className="md-img"
        title="点击放大"
        onClick={() => setOpen(true)}
      >
        <img src={state.url} alt={state.name} loading="lazy" />
      </Button>
      {open && (
        <ImageViewer
          images={[{ id: src ?? "", name: state.name, src: state.url }]}
          index={0}
          onIndex={() => {}}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
