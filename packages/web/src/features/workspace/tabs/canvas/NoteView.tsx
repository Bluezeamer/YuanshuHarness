// 笔记视图：canvas 标签主区显示一篇笔记（.canvas 里的 .md）。读写走画布接口（带基线，写入记进画布仓库的历史），
// 不借文件预览；两种形态：预览（渲染 markdown，[[链接]] 可点）与编辑（CodeMirror）。控件（形态切换、未保存、保存）
// 放进标签顶部工具条的槽位，没有保存的改动只在这里，离开前由标签确认。
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { readCard, saveCard } from "../../../../api/canvas";
import { loadToken } from "../../../../api/http";
import {
  Button,
  Dot,
  Empty,
  InlineNotice,
  Loading,
  Segmented,
  toast,
} from "../../../../ui";
import { useFsWatch } from "../../../chat";
import type { ImageBase } from "../../../markdown/imageRef";
import { getFileDrag } from "../files/dndStore";
import { joinPath } from "../files/paths";
import { BarPortal } from "../preview/BarSlots";
import { ConflictDialog } from "../preview/ConflictDialog";
import { MarkdownView } from "../preview/MarkdownView";
import { type EditorHandle, mountEditor } from "../preview/mountEditor";
import { useAddToChat } from "../useAddToChat";
import { saveNoteImages } from "./noteImages";
import { canvasFileLabel, previewSelection, wholeLines } from "./quote";
import { dropTextOf, fileDirOf } from "./refText";

type Base = { mtimeMs: number | null; sha256: string | null };
type Loaded =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; text: string; base: Base };
type Mode = "preview" | "edit";

// 自己保存后这么久之内收到的变更认为是自己的写入，不弹「已被改动」
const OWN_SAVE_MS = 2000;

export interface NoteViewProps {
  env: string;
  /** 画布所在目录（绝对路径） */
  dir: string;
  /** 画布所在主机的展示名：引用来源标签里写它 */
  hostLabel: string;
  /** 笔记路径，相对 `.canvas/` */
  path: string;
  sessionId: string | null;
  /** 有没有没保存的改动：标签据此在离开前确认 */
  onDirtyChange(dirty: boolean): void;
  /** 点了正文里的 `[[目标]]`（目标相对 `.canvas/`） */
  onWikilink(target: string): void;
  /** 标签的 Ctrl+S 通过它存这篇笔记（在预览态也要能存） */
  saveRef: RefObject<(() => void) | null>;
}

export function NoteView({
  env,
  dir,
  hostLabel,
  path,
  sessionId,
  onDirtyChange,
  onWikilink,
  saveRef,
}: NoteViewProps) {
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const [mode, setMode] = useState<Mode>("preview");
  // 正文里的相对图片地址相对这篇笔记所在文件夹，走画布接口（读 Server 本机副本，ssh 项目也不等镜像推完）
  const imageBase = useMemo<ImageBase>(
    () => ({ kind: "canvas", env, project: dir, note: path }),
    [env, dir, path],
  );
  // 编辑器里改过的正文；null = 和磁盘上读到的一样
  const [draft, setDraft] = useState<string | null>(null);
  // 换了磁盘版本（载入、重载、冲突里选了一边）：编辑器要按新的重建
  const [epoch, setEpoch] = useState(0);
  const [saving, setSaving] = useState(false);
  const [moved, setMoved] = useState(false);
  const [conflict, setConflict] = useState<{
    disk: { text: string; base: Base };
    mine: string;
  } | null>(null);
  const savedAt = useRef(0);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorHandle | null>(null);
  const read = useRef<HTMLDivElement>(null);
  const addToChat = useAddToChat(sessionId);
  const text = loaded.phase === "ready" ? loaded.text : "";
  const dirty = draft !== null && draft !== text;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  // 离开这篇笔记（卸载）时不再算有未保存的改动
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const fetchDisk = useCallback(async () => {
    const r = await readCard(loadToken(), env, dir, path);
    return r.ok
      ? {
          text: r.data.text,
          base: { mtimeMs: r.data.mtimeMs, sha256: r.data.sha256 },
        }
      : null;
  }, [env, dir, path]);

  // 首次载入：空笔记直接进编辑，有内容先看渲染
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换了笔记组件会重建（key），只在挂载时载入
  useEffect(() => {
    let alive = true;
    void readCard(loadToken(), env, dir, path).then((r) => {
      if (!alive) return;
      if (!r.ok) {
        setLoaded({
          phase: "error",
          message:
            r.kind === "not_found" ? "这篇笔记不存在了" : "读不出这篇笔记",
        });
        return;
      }
      setLoaded({
        phase: "ready",
        text: r.data.text,
        base: { mtimeMs: r.data.mtimeMs, sha256: r.data.sha256 },
      });
      setMode(r.data.text.trim() === "" ? "edit" : "preview");
      setEpoch((e) => e + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 磁盘上的变化：没有未保存的改动就直接换成新的，有就只提示
  const watchRoot = joinPath(joinPath(dir, ".canvas"), path);
  const rev = useFsWatch(sessionId ?? undefined, env, [watchRoot]);
  const handled = useRef(rev);
  useEffect(() => {
    if (rev === handled.current) return;
    handled.current = rev;
    if (Date.now() - savedAt.current < OWN_SAVE_MS) return;
    if (dirty) return setMoved(true);
    void fetchDisk().then((disk) => {
      if (!disk) return;
      setLoaded((cur) =>
        cur.phase === "ready" && cur.base.sha256 === disk.base.sha256
          ? cur
          : { phase: "ready", ...disk },
      );
      setEpoch((e) => e + 1);
    });
  }, [rev, dirty, fetchDisk]);

  // 编辑器：进编辑态、或磁盘版本换了才重建；正文每次按键都在 draft 里，不进依赖
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const saveNow = useRef<() => void>(() => {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch 变了要按新的磁盘版本重建
  useEffect(() => {
    const el = host.current;
    if (!el || mode !== "edit" || loaded.phase !== "ready") return;
    let alive = true;
    let handle: EditorHandle | null = null;
    void mountEditor({
      parent: el,
      doc: draftRef.current ?? loaded.text,
      path: "笔记.md",
      readOnly: false,
      onChange: (_d, next) => setDraft(next),
      onSave: () => saveNow.current(),
      // 把树里的笔记 / 画布、文件管理器里的文件拖进来：自动写成 [[链接]] / 标准链接
      onDropText: (e) =>
        dropTextOf(e, {
          fileDir: fileDirOf(dir, path),
          env,
          projectDir: dir,
          getFileDrag,
        }),
      // 粘贴 / 从系统拖入图片：存进笔记旁边的 <笔记名>.assets/，插入相对笔记的链接
      onFiles: async (files, via) => {
        const r = await saveNoteImages(env, dir, path, files, via);
        if (r.ok) return r.text;
        toast(`图片没能存下来：${r.why}`, { tone: "danger" });
        return null;
      },
    }).then((h) => {
      if (!alive) return h.destroy();
      handle = h;
      editor.current = h;
      h.focus();
    });
    return () => {
      alive = false;
      editor.current = null;
      handle?.destroy();
    };
  }, [mode, loaded.phase, epoch, dir, env, path]);

  const write = async (body: string, base: Base): Promise<boolean> => {
    setSaving(true);
    savedAt.current = Date.now();
    const r = await saveCard(loadToken(), env, dir, path, body, base);
    setSaving(false);
    if (r.ok) {
      setLoaded({ phase: "ready", text: body, base: r.data });
      setDraft(null);
      setMoved(false);
      return true;
    }
    if ("conflict" in r) {
      const disk = await fetchDisk();
      if (disk) setConflict({ disk, mine: body });
      else toast("读不出磁盘上的版本，稍后再保存", { tone: "danger" });
    } else toast("保存失败，请重试", { tone: "danger" });
    return false;
  };
  const save = () => {
    if (loaded.phase !== "ready" || !dirty || saving) return;
    void write(draft as string, loaded.base).then((ok) => {
      if (ok) toast("已保存", { tone: "ok" });
    });
  };

  saveNow.current = save;
  useEffect(() => {
    saveRef.current = () => saveNow.current();
    return () => {
      saveRef.current = null;
    };
  }, [saveRef]);

  // 选中了就引用选中的（编辑态按编辑器选区，预览态按渲染出来的选区），没选就引用整篇
  const quote = () => {
    const source = draft ?? text;
    const picked =
      mode === "edit"
        ? editor.current?.selection()
        : read.current && previewSelection(read.current, source);
    const body = picked ? picked.text : source;
    if (body.trim() === "") {
      toast("这篇笔记还是空的", { tone: "warn" });
      return;
    }
    const lines = picked
      ? "lines" in picked
        ? picked.lines
        : { from: picked.from, to: picked.to }
      : wholeLines(source);
    addToChat(canvasFileLabel(hostLabel, dir, path, lines), body);
  };

  const discard = () => {
    setDraft(null);
    setEpoch((e) => e + 1);
  };
  const loadDisk = () => {
    void fetchDisk().then((disk) => {
      if (!disk) return;
      setLoaded({ phase: "ready", ...disk });
      setDraft(null);
      setMoved(false);
      setEpoch((e) => e + 1);
    });
  };

  if (loaded.phase === "loading") return <Loading>正在读取</Loading>;
  if (loaded.phase === "error")
    return <Empty tone="danger" title={loaded.message} />;

  return (
    <div className="cv-note">
      <BarPortal slot="tail">
        <Segmented
          size="sm"
          aria-label="显示方式"
          options={[
            { value: "preview", label: "预览" },
            { value: "edit", label: "编辑" },
          ]}
          value={mode}
          onChange={setMode}
        />
        <Button
          size="sm"
          variant="ghost"
          title="把选中的内容（没有选中就是整篇）连同来源加进对话的输入框"
          // 点按钮不要让选区丢掉
          onMouseDown={(e) => e.preventDefault()}
          onClick={quote}
        >
          添加到对话
        </Button>
        <span className="cv-gap" />
        {dirty && (
          <span className="cv-save t-aux" aria-live="polite" title="未保存">
            <Dot tone="warn" size="sm" />
            <span className="cv-save-text">未保存</span>
          </span>
        )}
        {dirty && (
          <Button size="sm" variant="ghost" onClick={discard}>
            还原
          </Button>
        )}
        <Button
          size="sm"
          variant={dirty ? "primary" : "ghost"}
          loading={saving}
          disabled={!dirty}
          title="Ctrl+S"
          onClick={save}
        >
          保存
        </Button>
      </BarPortal>
      {moved && (
        <InlineNotice tone="warn">
          这篇笔记在别处被改动了。
          <Button size="sm" variant="ghost" onClick={loadDisk}>
            放弃我的修改，加载磁盘版本
          </Button>
        </InlineNotice>
      )}
      {mode === "edit" ? (
        <div className="cv-note-edit" ref={host} />
      ) : (
        <div className="cv-note-read" ref={read}>
          <MarkdownView
            text={draft ?? text}
            onWikilink={onWikilink}
            imageBase={imageBase}
          />
        </div>
      )}
      {conflict && (
        <ConflictDialog
          path={path}
          diskText={conflict.disk.text}
          mineText={conflict.mine}
          onCancel={() => setConflict(null)}
          onKeepDisk={() => {
            setLoaded({ phase: "ready", ...conflict.disk });
            setDraft(null);
            setConflict(null);
            setMoved(false);
            setEpoch((e) => e + 1);
          }}
          onOverwrite={() => {
            const { mine, disk } = conflict;
            setConflict(null);
            void write(mine, disk.base);
          }}
          onMerge={(merged) => {
            const disk = conflict.disk;
            setConflict(null);
            void write(merged, disk.base).then((ok) => {
              if (ok) setEpoch((e) => e + 1);
            });
          }}
        />
      )}
    </div>
  );
}
