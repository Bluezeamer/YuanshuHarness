// 文本 / 代码 / JSON 的可编辑视图：CodeMirror 高亮 + 脏标记 + 保存 + 冲突三选一。
// 编辑内容防抖存进浏览器本地（fileDraft.ts）：切到预览、切走标签、关掉标签、刷新都不丢，下次打开恢复。
import { useCallback, useEffect, useRef, useState } from "react";
import { type SaveBase, saveTextFile } from "../../../../api/files";
import { loadToken } from "../../../../api/http";
import { Button, Dot, toast } from "../../../../ui";
import { BarPortal } from "./BarSlots";
import { ConflictDialog } from "./ConflictDialog";
import { dropFileDraft, loadFileDraft, stashFileDraft } from "./fileDraft";
import { type EditorHandle, type EditorPos, mountEditor } from "./mountEditor";

export interface CodeEditorProps {
  env: string;
  path: string;
  /** 首次内容与对应的编辑基线 */
  text: string;
  base: SaveBase;
  sessionId?: string | null;
  /** 保存成功后把新基线交给上层（后续保存用它判冲突） */
  onSaved(next: { text: string; base: SaveBase }): void;
  /** 只读：只有高亮与滚动，没有保存条、不能改（超限降级用） */
  readOnly?: boolean;
  /** 未保存改动变化（外层据此决定外部改动时能否自动重载） */
  onDirtyChange?: (dirty: boolean) => void;
  /** 上次的光标与滚动位置（只用于首次建好编辑器） */
  initialView?: EditorPos;
  /** 光标或滚动位置变了 */
  onViewChange?: (v: EditorPos) => void;
  /** 粘贴 / 拖入了文件（md 里存图片用）：返回要插入的文本；不给就不处理文件，照常粘贴 */
  onFiles?: (files: File[], via: "paste" | "drop") => Promise<string | null>;
}

export function CodeEditor({
  env,
  path,
  text,
  base,
  sessionId = null,
  onSaved,
  readOnly = false,
  onDirtyChange,
  initialView,
  onViewChange,
  onFiles,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorHandle | null>(null);
  const [dirty, setDirty] = useState(false);
  // 与 dirty 同步的 ref：基线同步的 effect 要在 dirty 还没渲染出来时就判断「有没有草稿在身上」
  const dirtyRef = useRef(false);
  const markDirty = useCallback((v: boolean) => {
    dirtyRef.current = v;
    setDirty(v);
  }, []);
  // 磁盘上现在的内容（保存成功后推进）：「有没有改动」与草稿是否有意义都以它为准
  const disk = useRef(text);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{
    disk: { text: string; base: SaveBase };
    mine: string;
  } | null>(null);
  // 光标与滚动位置：保存后编辑器会按新内容重建，靠它回到原处；换了文件就不用了
  const pos = useRef<(EditorPos & { path: string }) | null>(
    initialView ? { ...initialView, path } : null,
  );
  const reportView = useRef(onViewChange);
  reportView.current = onViewChange;
  const filesRef = useRef(onFiles);
  filesRef.current = onFiles;
  const takesFiles = onFiles !== undefined;
  // 基线随保存推进；用 ref 免得回调闭包拿到旧值
  const baseline = useRef(base);
  // 保存动作要在 CodeMirror 的按键回调里调用，用 ref 取最新实现
  const saveNow = useRef<() => void>(() => {});

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let alive = true;
    let handle: EditorHandle | null = null;
    disk.current = text;
    // 上次没保存的草稿：恢复它，基线用当时开始编辑的那一版，磁盘变过则保存时走冲突合并
    const draft = readOnly ? null : loadFileDraft(env, path, text);
    if (draft) {
      baseline.current = draft.base;
      toast("已恢复上次没保存的改动", { tone: "ok" });
    }
    markDirty(draft !== null);
    void mountEditor({
      parent: el,
      doc: draft?.text ?? text,
      path,
      readOnly,
      onChange: (_d, t) => {
        const changed = t !== disk.current;
        markDirty(changed);
        if (changed) stashFileDraft(env, path, t, baseline.current);
        else dropFileDraft(env, path);
      },
      onSave: () => saveNow.current(),
      ...(takesFiles
        ? {
            onFiles: async (f: File[], via: "paste" | "drop") =>
              (await filesRef.current?.(f, via)) ?? null,
          }
        : {}),
      ...(pos.current?.path === path ? { initialView: pos.current } : {}),
      onViewChange: (v) => {
        pos.current = { ...v, path };
        reportView.current?.(v);
      },
    }).then((h) => {
      if (!alive) {
        h.destroy();
        return;
      }
      handle = h;
      editor.current = h;
    });
    return () => {
      alive = false;
      handle?.destroy();
      editor.current = null;
    };
  }, [env, path, text, readOnly, markDirty, takesFiles]);

  // 基线变了（换文件或保存成功）就同步，避免用旧 sha 反复报冲突；身上带着恢复出来的草稿时保留草稿的基线
  useEffect(() => {
    if (!dirtyRef.current) baseline.current = base;
  }, [base]);

  // 保存 / 还原 / 取磁盘版之后：不再有改动，草稿作废
  const clean = useCallback(
    (diskText: string) => {
      disk.current = diskText;
      markDirty(false);
      dropFileDraft(env, path);
    },
    [env, path, markDirty],
  );

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // 取磁盘当前内容（冲突时用）
  const fetchDisk = useCallback(async () => {
    const { readTextFile } = await import("../../../../api/files");
    const r = await readTextFile(loadToken(), env, path);
    return r.ok
      ? {
          text: r.data.text,
          base: { mtimeMs: r.data.mtimeMs, sha256: r.data.sha256 },
        }
      : { text: "", base: { mtimeMs: null, sha256: null } };
  }, [env, path]);

  const save = useCallback(async () => {
    const ed = editor.current;
    if (!ed || saving) return;
    const mine = ed.doc();
    if (mine === text && !dirty) return;
    setSaving(true);
    const r = await saveTextFile(
      loadToken(),
      env,
      path,
      mine,
      baseline.current,
      sessionId,
    );
    setSaving(false);
    if (r.ok) {
      const next = {
        text: mine,
        base: { mtimeMs: r.data.mtimeMs, sha256: r.data.sha256 },
      };
      baseline.current = next.base;
      // 用编辑器里的真实内容对齐，避免尾随换行差异把文件又标脏
      ed.setDoc(next.text);
      clean(next.text);
      onSaved(next);
      toast("已保存", { tone: "ok" });
      return;
    }
    if ("conflict" in r) {
      // 冲突：把磁盘上的当前内容取回来，让用户看着办
      const disk = await fetchDisk();
      setConflict({ disk, mine });
      return;
    }
    toast(
      r.kind === "not_found"
        ? "文件已不存在"
        : r.kind === "forbidden"
          ? "没有写入权限"
          : r.kind === "too_large"
            ? "文件太大，无法保存"
            : "保存失败，请重试",
      { tone: "danger" },
    );
  }, [clean, dirty, env, fetchDisk, onSaved, path, saving, sessionId, text]);

  saveNow.current = () => void save();

  return (
    <div className="ws-pv-edit">
      <div className="ws-pv-edit-body" ref={host} />
      {!readOnly && (
        <BarPortal slot="tail">
          {dirty && (
            <span className="ws-pv-dirty t-aux" aria-live="polite">
              <Dot tone="warn" size="sm" />
              未保存
            </span>
          )}
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                editor.current?.setDoc(disk.current);
                clean(disk.current);
              }}
            >
              还原
            </Button>
          )}
          <Button
            size="sm"
            variant={dirty ? "primary" : "ghost"}
            loading={saving}
            disabled={!dirty}
            title="Ctrl+S"
            onClick={() => void save()}
          >
            保存
          </Button>
        </BarPortal>
      )}
      {conflict && (
        <ConflictDialog
          path={path}
          diskText={conflict.disk.text}
          mineText={conflict.mine}
          onCancel={() => setConflict(null)}
          onKeepDisk={() => {
            editor.current?.setDoc(conflict.disk.text);
            baseline.current = conflict.disk.base;
            clean(conflict.disk.text);
            setConflict(null);
            toast("已载入磁盘上的内容", { tone: "ok" });
          }}
          onMerge={async (merged) => {
            // 用磁盘基线写回去：这次比对的仍是「我刚看到的那份磁盘内容」
            const r = await saveTextFile(
              loadToken(),
              env,
              path,
              merged,
              conflict.disk.base,
              sessionId,
            );
            setConflict(null);
            if (r.ok) {
              const next = {
                text: merged,
                base: { mtimeMs: r.data.mtimeMs, sha256: r.data.sha256 },
              };
              baseline.current = next.base;
              editor.current?.setDoc(merged);
              clean(merged);
              onSaved(next);
              toast("已保存合并结果", { tone: "ok" });
            } else {
              toast("合并结果保存失败，请重试", { tone: "danger" });
            }
          }}
          onOverwrite={async () => {
            // 用磁盘基线重试：这一次比对的是「我刚看到的那份磁盘内容」
            const mine = conflict.mine;
            const r = await saveTextFile(
              loadToken(),
              env,
              path,
              mine,
              conflict.disk.base,
              sessionId,
            );
            setConflict(null);
            if (r.ok) {
              const next = {
                text: mine,
                base: { mtimeMs: r.data.mtimeMs, sha256: r.data.sha256 },
              };
              baseline.current = next.base;
              editor.current?.setDoc(mine);
              clean(mine);
              onSaved(next);
              toast("已覆盖保存", { tone: "ok" });
            } else {
              toast("覆盖失败，请重试", { tone: "danger" });
            }
          }}
        />
      )}
    </div>
  );
}
