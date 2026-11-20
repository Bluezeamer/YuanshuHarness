// 预览数据的加载状态机。路径变了（含移动后跟随新路径）就重新取。
// 图片、PDF 与解析类（docx/xlsx/pptx/epub）都要整份字节，取之前先用 stat 判体积：
// 超限就不拉，交给「太大」态提示下载——几个 G 的文档在浏览器里解析必然卡死。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  readBytes,
  readPreview,
  readTextFile,
  type SaveBase,
  statFile,
} from "../../../../api/files";
import { loadToken, type RawFailure } from "../../../../api/http";
import { isText, kindByExt, type ParseKind, PREVIEW_LIMIT } from "./kind";
import { IMAGE_MAX, PARSE_MAX, PDF_MAX, TEXT_MAX } from "./limits";
export type PreviewState =
  | { kind: "loading" }
  | {
      /** 文本类：text/json 是纯源码；markdown/html/svg 有渲染态 */
      kind: "text" | "markdown" | "json" | "svg";
      text: string;
      total: number;
      shown: number;
      /** 可编辑（= 文本没超过 5MB 上限） */
      editable: boolean;
      mtimeMs: number | null;
      sha256: string | null;
    }
  | { kind: "image"; url: string }
  | { kind: "pdf"; bytes: Uint8Array }
  | { kind: ParseKind; bytes: Uint8Array }
  | {
      kind: "html";
      html: string;
      editable: boolean;
      mtimeMs: number | null;
      sha256: string | null;
    }
  | { kind: "too_large"; total: number; max: number }
  | { kind: "binary"; contentType: string; total: number }
  | { kind: "error"; failure: RawFailure };

/** 解析类格式（要整份字节再解析）。 */
const isParse = (kind: string | undefined): kind is ParseKind =>
  kind === "docx" || kind === "sheet" || kind === "pptx" || kind === "epub";

export function usePreview(
  env: string,
  path: string,
): {
  state: PreviewState;
  retry(): void;
  /** 编辑器保存成功后把内容灌回来：预览态立刻反映刚写下的内容，不用重新拉一遍（也不必等 fs.changed） */
  applySaved(next: { text: string; base: SaveBase }): void;
  /** 同一个文件正在后台重取（不清空已有内容，避免子组件卸载导致预览/编辑模式被重置） */
  refreshing: boolean;
} {
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // 已经加载完成的「env:path」：同一个文件重取时保留现有内容，只标 refreshing
  const loaded = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce 只用来让「重试」重新触发加载
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    const key = `${env}:${path}`;
    // 同一文件的重取不要退回 loading：否则 TextView 卸载重挂，预览/编辑模式和草稿都会被重置
    if (loaded.current === key) setRefreshing(true);
    else {
      loaded.current = null;
      setState({ kind: "loading" });
    }
    // 统一出口：标记已加载、清掉「后台重取中」，避免各处漏写
    const commit = (next: PreviewState) => {
      loaded.current = key;
      setRefreshing(false);
      setState(next);
    };
    const fail = (failure: RawFailure) =>
      alive && commit({ kind: "error", failure });
    const token = loadToken();

    void (async () => {
      const hint = kindByExt(path);
      const kind = hint?.kind;
      const limit =
        kind === "image"
          ? IMAGE_MAX
          : kind === "pdf"
            ? PDF_MAX
            : isParse(kind)
              ? PARSE_MAX
              : null;

      if (kind !== undefined && limit !== null) {
        const st = await statFile(token, env, path);
        if (!alive) return;
        if (!st.ok && st.kind === "not_found") return fail("not_found");
        const size = st.ok ? st.data.size : 0;
        if (st.ok && size > limit)
          return commit({ kind: "too_large", total: size, max: limit });
        const r = await readBytes(token, env, path);
        if (!alive) return;
        if (!r.ok) return fail(r.kind);
        if (kind === "pdf") return commit({ kind: "pdf", bytes: r.data });
        if (kind === "image") {
          const mime = hint?.kind === "image" ? hint.mime : "image/png";
          objectUrl = URL.createObjectURL(
            new Blob([r.data as BlobPart], { type: mime }),
          );
          return commit({ kind: "image", url: objectUrl });
        }
        if (isParse(kind)) return commit({ kind, bytes: r.data });
        return fail("server");
      }

      // 文本类：先看大小。不超过上限就整份读回来（带 mtime/sha256 基线，可编辑）；
      // 超了才退回按范围只读预览，避免把几十 MB 文本塞进浏览器。
      const st = await statFile(token, env, path);
      if (!alive) return;
      if (!st.ok && st.kind === "not_found") return fail("not_found");
      const whole = st.ok && st.data.size <= TEXT_MAX;

      if (whole) {
        const full = await readTextFile(token, env, path);
        if (!alive) return;
        if (!full.ok) return fail(full.kind);
        const d = full.data;
        // 整份读回来时没法再靠 Content-Type 判断，直接看有没有 NUL（二进制基本上都有）
        if (d.text.slice(0, 8192).includes("\u0000"))
          return commit({ kind: "binary", contentType: "", total: d.total });
        const base = { mtimeMs: d.mtimeMs, sha256: d.sha256 };
        if (hint?.kind === "html")
          return commit({
            kind: "html",
            html: d.text,
            editable: !d.truncated,
            ...base,
          });
        return commit({
          kind:
            hint?.kind === "markdown"
              ? "markdown"
              : hint?.kind === "json"
                ? "json"
                : hint?.kind === "svg"
                  ? "svg"
                  : "text",
          text: d.text,
          total: d.total,
          // 整份读回来就是全部内容；shown 与 total 都按字节算，别让 CJK 文本误判成被截断
          shown: d.truncated ? d.text.length : d.total,
          // markdown / html / svg 都有源码可改；截断时不开放编辑
          editable: !d.truncated,
          ...base,
        });
      }

      const r = await readPreview(token, env, path, PREVIEW_LIMIT, false);
      if (!alive) return;
      if (!r.ok) return fail(r.kind);
      const p = r.data;
      if (!isText(p.contentType, p.bytes))
        return commit({
          kind: "binary",
          contentType: p.contentType,
          total: p.total,
        });
      commit({
        kind: "text",
        text: new TextDecoder("utf-8").decode(p.bytes),
        total: p.total,
        shown: p.bytes.length,
        editable: false,
        mtimeMs: null,
        sha256: null,
      });
    })();

    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [env, path, nonce]);

  // retry 必须稳定：外层 effect 依赖它，每次渲染换新身份会让「文件变了 → 重取」变成死循环。
  const retry = useCallback(() => setNonce((n) => n + 1), []);
  const applySaved = useCallback(
    (next: { text: string; base: SaveBase }) =>
      setState((cur) => {
        if (!cur) return cur;
        if (cur.kind === "html")
          return {
            ...cur,
            html: next.text,
            mtimeMs: next.base.mtimeMs,
            sha256: next.base.sha256,
          };
        if (
          cur.kind === "text" ||
          cur.kind === "markdown" ||
          cur.kind === "json" ||
          cur.kind === "svg"
        )
          return {
            ...cur,
            text: next.text,
            total: next.text.length,
            shown: next.text.length,
            mtimeMs: next.base.mtimeMs,
            sha256: next.base.sha256,
          };
        return cur;
      }),
    [],
  );
  return { state, retry, applySaved, refreshing };
}
