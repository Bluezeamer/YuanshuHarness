// 文本编辑器：CodeMirror 6。
// 语言不自己维护白名单：用官方的 @codemirror/language-data 注册表（140+ 语言，按文件名/扩展名匹配），
// 语言包按需动态加载，不进主包。认不出来的扩展名就当纯文本。
import type { LanguageDescription } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

/** 注册表没登记扩展名、但确实有对应语言的少数情况 */
const BY_NAME: Record<string, string> = {
  // nginx 在注册表里有语言，但没登记扩展名
  "nginx.conf": "Nginx",
};

const fileNameOf = (path: string): string =>
  path.split("/").filter(Boolean).pop() ?? "";

// 语言注册表与匹配 API 都要按需加载：@codemirror/language 静态依赖 @codemirror/view，
// 顶层静态 import 会把编辑器内核连带默认主题色一起打进入口包（token 守卫会拦）。
let langMod: Promise<{
  match: (name: string) => LanguageDescription | null;
  byName: (name: string) => LanguageDescription | null;
}> | null = null;

function langHelpers() {
  langMod ??= Promise.all([
    import("@codemirror/language"),
    import("@codemirror/language-data"),
  ]).then(([lang, data]) => ({
    match: (name: string) =>
      lang.LanguageDescription.matchFilename(data.languages, name),
    byName: (name: string) =>
      lang.LanguageDescription.matchLanguageName(data.languages, name, true),
  }));
  return langMod;
}

/** 按文件名 / 扩展名找语言；认不出来返回 null（纯文本） */
export async function langDescFor(
  path: string,
): Promise<LanguageDescription | null> {
  const h = await langHelpers();
  const name = fileNameOf(path);
  const byName = BY_NAME[name.toLowerCase()];
  if (byName) {
    const hit = h.byName(byName);
    if (hit) return hit;
  }
  // 注册表按文件名与扩展名匹配（含 Cargo.toml → TOML、Dockerfile → Dockerfile 这类）
  return h.match(name);
}

/** 匹配到的语言名（给测试与诊断用）；纯文本返回 null */
export async function langNameFor(path: string): Promise<string | null> {
  return (await langDescFor(path))?.name ?? null;
}

/** 取高亮扩展：按需加载（首次用到某语言时才拉对应的解析器） */
export async function languageExt(path: string): Promise<Extension[]> {
  const desc = await langDescFor(path);
  if (!desc) return [];
  if (desc.support) return [desc.support];
  return desc.load().then(
    (support): Extension[] => [support],
    // 语言包加载失败不该让编辑器空白：退回纯文本
    (): Extension[] => [],
  );
}

/** 编辑器的光标与滚动位置：切走再切回、保存后重建编辑器时靠它还原 */
export interface EditorPos {
  caret: number;
  top: number;
}

export interface EditorHandle {
  /** 取当前正文 */
  doc(): string;
  /** 换成别的内容（保存成功后对齐，或放弃修改时回滚） */
  setDoc(text: string): void;
  /** 选中的文字与它所在的行号区间（从 1 起）；没选中内容返回 null */
  selection(): { text: string; from: number; to: number } | null;
  /** 聚焦并把光标放到末尾 */
  focus(): void;
  destroy(): void;
}

/**
 * 在宿主元素里建一个编辑器。readOnly 时就是带高亮的只读视图。
 * onChange 只在用户编辑时触发（程序内 setDoc 不触发），避免保存后被标脏。
 */
export async function mountEditor(opts: {
  parent: HTMLElement;
  doc: string;
  /** 用来推断语言的路径（文件名/扩展名） */
  path: string;
  readOnly: boolean;
  /** 紧凑：没有行号与折叠栏，用正文的字体与字号（画布卡片里原地编辑用） */
  compact?: boolean;
  onChange(dirty: boolean, text: string): void;
  onSave(): void;
  /** 建好后还原到这个光标与滚动位置 */
  initialView?: EditorPos;
  /** 光标或滚动位置变了（含建好后的还原） */
  onViewChange?(v: EditorPos): void;
  /**
   * 拖东西进编辑器：返回要插入的文本就在落点处插入（并拦下浏览器的默认处理），返回 null 就不管、走默认。
   * dragover 时也会问一次（给 null 就不放行），所以实现要便宜、不能有副作用。
   */
  onDropText?(e: DragEvent): string | null;
  /**
   * 粘贴 / 从系统拖入了文件：返回要插入的文本就在光标（拖入是落点）处插入，返回 null 什么都不插（粘贴的文件不会再落成别的东西）。
   * 粘贴时剪贴板里还带着文字（比如从表格复制）就不算文件粘贴，照常粘贴文字。
   */
  onFiles?(files: File[], via: "paste" | "drop"): Promise<string | null>;
}): Promise<EditorHandle> {
  const [langExt, state, view, cmds, lang] = await Promise.all([
    languageExt(opts.path),
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/commands"),
    import("@codemirror/language"),
  ]);
  const { EditorState, Compartment, Annotation } = state;
  // 程序内改文档（保存成功后对齐 / 放弃修改回滚）不算「用户编辑」，不能标脏
  const programmatic = Annotation.define<boolean>();
  const { EditorView, lineNumbers, keymap, highlightActiveLine } = view;

  // 只读性是独立 compartment：切换视图模式时不用重建整个编辑器
  const editable = new Compartment();
  const readOnly = () => [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
  ];
  const editableOf = () => [];

  const save = {
    key: "Mod-s",
    preventDefault: true,
    run: () => {
      opts.onSave();
      return true;
    },
  };

  // updateListener 在 EditorView 建好前就要引用：先占位，建好后接上
  let reportView = () => {};

  /** 等调用方把文件处理完（上传），再把返回的文本插进去；等的时候编辑器可能已销毁或文档变短，位置要夹一下 */
  const insertFromFiles = async (
    view: InstanceType<typeof EditorView>,
    files: File[],
    via: "paste" | "drop",
    at: number | null,
  ) => {
    const text = (await opts.onFiles?.(files, via)) ?? null;
    if (text === null || !view.dom.isConnected) return;
    const pos = Math.min(
      at ?? view.state.selection.main.head,
      view.state.doc.length,
    );
    view.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
      userEvent: via === "drop" ? "input.drop" : "input.paste",
    });
    view.focus();
  };

  const v = new EditorView({
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        ...(opts.compact ? [] : [lineNumbers(), lang.foldGutter()]),
        cmds.history(),
        keymap.of(cmds.defaultKeymap),
        keymap.of([save, cmds.indentWithTab]),
        langExt,
        lang.syntaxHighlighting(lang.defaultHighlightStyle, { fallback: true }),
        highlightActiveLine(),
        EditorView.lineWrapping,
        ...(opts.onDropText || opts.onFiles
          ? [
              EditorView.domEventHandlers({
                dragover: (e) => {
                  const files =
                    opts.onFiles !== undefined &&
                    e.dataTransfer?.types.includes("Files") === true;
                  if (!files && (opts.onDropText?.(e) ?? null) === null)
                    return false;
                  e.preventDefault();
                  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
                  return true;
                },
                drop: (e, view) => {
                  const files = [...(e.dataTransfer?.files ?? [])];
                  const at =
                    view.posAtCoords({ x: e.clientX, y: e.clientY }) ??
                    view.state.selection.main.head;
                  if (opts.onFiles && files.length > 0) {
                    e.preventDefault();
                    void insertFromFiles(view, files, "drop", at);
                    return true;
                  }
                  const text = opts.onDropText?.(e) ?? null;
                  if (text === null) return false;
                  e.preventDefault();
                  view.dispatch({
                    changes: { from: at, insert: text },
                    selection: { anchor: at + text.length },
                    userEvent: "input.drop",
                  });
                  view.focus();
                  return true;
                },
                paste: (e, view) => {
                  const files = [...(e.clipboardData?.files ?? [])];
                  if (
                    !opts.onFiles ||
                    files.length === 0 ||
                    e.clipboardData?.getData("text/plain")
                  )
                    return false;
                  e.preventDefault();
                  void insertFromFiles(view, files, "paste", null);
                  return true;
                },
              }),
            ]
          : []),
        editable.of(opts.readOnly ? readOnly() : editableOf()),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet) reportView();
          if (!u.docChanged) return;
          if (u.transactions.some((t) => t.annotation(programmatic))) return;
          opts.onChange(true, u.state.doc.toString());
        }),
        EditorView.theme({
          // 字号跟代码档：这主题在预览态与编辑态共用同一份，引用变量所以切模式、改设置都即时生效
          "&": {
            height: "100%",
            fontSize: opts.compact
              ? "calc(var(--fs-read) * var(--tab-zoom, 1))"
              : "calc(var(--fs-code) * var(--tab-zoom, 1))",
          },
          ".cm-scroller": {
            fontFamily: opts.compact ? "var(--font-sans)" : "var(--font-mono)",
            overflow: "auto",
            ...(opts.compact ? { lineHeight: "1.72" } : {}),
          },
          ...(opts.compact ? { ".cm-line": { padding: "0" } } : {}),
          ".cm-gutters": {
            background: "transparent",
            border: "none",
            color: "var(--meta)",
          },
          "&.cm-focused": { outline: "none" },
        }),
      ],
    }),
    parent: opts.parent,
  });

  const viewOf = (): EditorPos => ({
    caret: v.state.selection.main.head,
    top: v.scrollDOM.scrollTop,
  });
  reportView = () => opts.onViewChange?.(viewOf());
  v.scrollDOM.addEventListener("scroll", reportView, { passive: true });
  if (opts.initialView) {
    const { caret, top } = opts.initialView;
    v.dispatch({ selection: { anchor: Math.min(caret, v.state.doc.length) } });
    // 编辑器刚建好、高度还没量完：下一帧再滚，否则会被夹回去
    requestAnimationFrame(() => {
      v.scrollDOM.scrollTop = top;
    });
  }

  return {
    doc: () => v.state.doc.toString(),
    setDoc: (text: string) =>
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: text },
        annotations: programmatic.of(true),
      }),
    selection: () => {
      const { from, to, empty } = v.state.selection.main;
      if (empty) return null;
      const doc = v.state.doc;
      // 整行选中时选区止于下一行行首，那一行并没有被选进来
      const last = doc.lineAt(to).from === to ? to - 1 : to;
      return {
        text: doc.sliceString(from, to),
        from: doc.lineAt(from).number,
        to: doc.lineAt(last).number,
      };
    },
    focus: () => {
      v.focus();
      v.dispatch({ selection: { anchor: v.state.doc.length } });
    },
    destroy: () => v.destroy(),
  };
}
