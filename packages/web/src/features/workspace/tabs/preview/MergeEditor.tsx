// 冲突合并：按 git 冲突的常规做法做——以「我的内容」为正文，把磁盘上的改动作为「对方」
// 逐块标记出来，每块可以选择采纳（要对方的）或保留我的；也可以一次性全要对方或全留我的。
// 用 CodeMirror 官方的 unifiedMergeView（与 VS Code 的合并视图同源），不自己写 diff/合并逻辑。
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../../ui";

export interface MergeEditorProps {
  /** 我的内容（正文起点） */
  mineText: string;
  /** 磁盘上的内容（对方的改动来源） */
  diskText: string;
  /** 用来选语法高亮 */
  path: string;
  /** 保存合并结果 */
  onSave(merged: string): void;
  onCancel(): void;
}

interface Handle {
  doc(): string;
  setDoc(text: string): void;
  acceptAll(): boolean;
  rejectAll(): boolean;
  destroy(): void;
}

export function MergeEditor({
  mineText,
  diskText,
  path,
  onSave,
  onCancel,
}: MergeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<Handle | null>(null);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let alive = true;
    let view: { destroy(): void } | null = null;
    void (async () => {
      const [state, viewMod, cmds, mount, merge] = await Promise.all([
        import("@codemirror/state"),
        import("@codemirror/view"),
        import("@codemirror/commands"),
        import("./mountEditor"),
        import("@codemirror/merge"),
      ]);
      if (!alive) return;
      const { EditorState, Annotation } = state;
      const { EditorView, lineNumbers, keymap, highlightActiveLine } = viewMod;
      // 程序内整篇替换（全采纳/全保留）不算「用户编辑」，但要更新按钮可用性
      const programmatic = Annotation.define<boolean>();
      const langExt = await mount.languageExt(path);
      if (!alive) return;
      const v = new EditorView({
        state: EditorState.create({
          doc: mineText,
          extensions: [
            lineNumbers(),
            cmds.history(),
            keymap.of(cmds.defaultKeymap),
            keymap.of([cmds.indentWithTab]),
            highlightActiveLine(),
            EditorView.lineWrapping,
            langExt,
            // 正文是我的内容；磁盘内容作为 original，逐块标出「对方的改动」
            merge.unifiedMergeView({
              original: diskText,
              gutter: true,
              // 逐块按钮自己渲染，文案与全局保持一致（默认是英文 Accept/Reject）
              mergeControls: (type, action) => {
                const b = document.createElement("button");
                b.type = "button";
                b.className = `ws-pv-merge3-btn is-${type} t-aux`;
                b.textContent = type === "accept" ? "采纳" : "退回";
                b.title =
                  type === "accept" ? "采纳磁盘上的这一处" : "保留我的这一处";
                b.addEventListener("click", action);
                return b;
              },
            }),
            EditorView.updateListener.of((u) => {
              if (
                u.docChanged &&
                !u.transactions.some((t) => t.annotation(programmatic))
              )
                setChanged(u.state.doc.toString() !== mineText);
            }),
          ],
        }),
        parent: el,
      });
      view = v;
      handle.current = {
        doc: () => v.state.doc.toString(),
        setDoc: (text) =>
          v.dispatch({
            changes: { from: 0, to: v.state.doc.length, insert: text },
            annotations: programmatic.of(true),
          }),
        acceptAll: () => merge.acceptChunk(v, 0),
        rejectAll: () => merge.rejectChunk(v, 0),
        destroy: () => v.destroy(),
      };
    })();
    return () => {
      alive = false;
      view?.destroy();
      handle.current = null;
    };
  }, [mineText, diskText, path]);

  const current = () => handle.current?.doc() ?? mineText;

  return (
    <div className="ws-pv-merge3">
      <p className="ws-pv-merge3-hint t-aux">
        正文是你的内容，高亮块是磁盘上的改动：块上的箭头可以采纳对方的写法，或退回你的。
      </p>
      <div className="ws-pv-merge3-body" ref={host} />
      <div className="ws-pv-merge3-bar">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            handle.current?.setDoc(mineText);
            setChanged(false);
          }}
        >
          全部保留我的
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            handle.current?.setDoc(diskText);
            setChanged(true);
          }}
        >
          全部采纳对方
        </Button>
        <span className="ws-pv-merge3-sp" />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!changed}
          onClick={() => onSave(current())}
        >
          保存合并结果
        </Button>
      </div>
    </div>
  );
}
