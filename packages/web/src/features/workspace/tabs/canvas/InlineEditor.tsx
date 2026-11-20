// 灵感卡的原地编辑：卡片里直接换成编辑器。编辑器不管保存：正文一变就交给 store 攒着，Ctrl+S 存整张画布。
// 新卡片（还没有文件）写的字也攒在 store 里（空的也行），第一次保存才建文件。
import { useEffect, useRef, useState } from "react";
import { Loading } from "../../../../ui";
import { getFileDrag } from "../files/dndStore";
import { type EditorHandle, mountEditor } from "../preview/mountEditor";
import { useNodeCtx } from "./nodeCtx";
import { dropTextOf, fileDirOf } from "./refText";

type Loaded =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; text: string };

export function InlineEditor({ file }: { file: string }) {
  const { loadCard, setText, save, env, dir } = useNodeCtx();
  const host = useRef<HTMLDivElement>(null);
  // 卡片改名、新卡片存成文件时路径会变，编辑器不重建：每次取最新的
  const fileRef = useRef(file);
  fileRef.current = file;
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });

  // 只在开始编辑时载入一次
  useEffect(() => {
    let alive = true;
    void loadCard(fileRef.current).then((r) => {
      if (alive)
        setLoaded(
          r.ok
            ? { phase: "ready", text: r.data }
            : { phase: "error", message: r.message },
        );
    });
    return () => {
      alive = false;
    };
  }, [loadCard]);

  const text = loaded.phase === "ready" ? loaded.text : null;
  useEffect(() => {
    const el = host.current;
    if (!el || text === null) return;
    let alive = true;
    let handle: EditorHandle | null = null;
    void mountEditor({
      parent: el,
      doc: text,
      path: "卡片.md",
      readOnly: false,
      compact: true,
      onChange: (_dirty, next) => setText(fileRef.current, next),
      onSave: save,
      // 拖进来的笔记 / 画布 / 项目文件自动写成引用（相对路径按这张卡片所在的文件夹换算）
      onDropText: (e) =>
        dropTextOf(e, {
          fileDir: fileDirOf(dir, fileRef.current),
          env,
          projectDir: dir,
          getFileDrag,
        }),
    }).then((h) => {
      if (!alive) return h.destroy();
      handle = h;
      h.focus();
    });
    return () => {
      alive = false;
      handle?.destroy();
    };
  }, [text, setText, save, env, dir]);

  if (loaded.phase === "loading") return <Loading compact>正在读取</Loading>;
  if (loaded.phase === "error")
    return (
      <div className="cv-muted t-aux">读不出这张卡片：{loaded.message}</div>
    );
  return (
    <div className="ws-pv-edit">
      <div className="ws-pv-edit-body" ref={host} />
    </div>
  );
}
