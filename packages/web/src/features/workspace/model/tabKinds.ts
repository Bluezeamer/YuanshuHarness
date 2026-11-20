// 标签类型的事实表：有哪些类型、各自带不带主机、「+」菜单能不能直接建。
// 新增一种类型：先在这里加一行；所在 feature 用 registerTab 接上图标、标题与渲染；
// 类型专属的字段在 l2.newTab 与 persist.parseTab 里各加一处。
//
// 主机档位（host）是唯一的规则来源，隔离、落点、「+」菜单选主机、载入兜底都从它派生：
//   none：没有主机（对话、执行体、浏览器），放进任何窗格
//   data：带主机，只当内容所在地（画布的目录在哪台主机），不参与窗格隔离，放进任何窗格
//   pane：带主机，窗格按主机隔离，一个窗格一次只装一台主机的这类标签（终端、文件、预览）
// 新类型默认选 none；内容要靠主机定位选 data；只有「这个窗格就是那台机器的工作面」才选 pane。

export interface TabKind {
  /** 类型名：悬停提示与占位标题 */
  label: string;
  /** 主机档位，见文件头 */
  host: "none" | "data" | "pane";
  /** 可以带会话 id，会话消失时标签随之关闭 */
  sid: boolean;
  /**
   * 「+」菜单里能直接新建。对话与预览不开放：建出来的空标签之后没有任何路径会往里填内容
   * （单击会话只换临时对话标签，单击文件只换同主机的临时预览），对话从会话行进、预览从文件点进。
   */
  creatable: boolean;
  /** Ctrl+滚轮能缩放内容（内容族字号、预览里的图片、终端字号）；别的类型自己有缩放，或没有可缩放的内容 */
  zoom?: true;
}

export const TAB_KINDS = {
  chat: {
    label: "对话",
    host: "none",
    sid: true,
    creatable: false,
    zoom: true,
  },
  sub: {
    label: "执行体",
    host: "none",
    sid: true,
    creatable: false,
    zoom: true,
  },
  job: {
    label: "后台任务",
    host: "none",
    sid: true,
    creatable: false,
    zoom: true,
  },
  term: {
    label: "终端",
    host: "pane",
    sid: false,
    creatable: true,
    zoom: true,
  },
  files: { label: "文件", host: "pane", sid: false, creatable: true },
  web: { label: "浏览器", host: "none", sid: false, creatable: true },
  preview: {
    label: "预览",
    host: "pane",
    sid: true,
    creatable: false,
    zoom: true,
  },
  canvas: { label: "画布", host: "data", sid: false, creatable: true },
} as const satisfies Record<string, TabKind>;

export type TabType = keyof typeof TAB_KINDS;

const TYPES = Object.keys(TAB_KINDS) as TabType[];

export const isTabType = (v: unknown): v is TabType =>
  typeof v === "string" && Object.hasOwn(TAB_KINDS, v);

/** Ctrl+滚轮能缩放内容字号的类型 */
export const isZoomable = (t: TabType): boolean => "zoom" in TAB_KINDS[t];

/** 标签带 `host` 字段（data 与 pane 两档） */
export const hasHost = (t: TabType): boolean => TAB_KINDS[t].host !== "none";

/** 窗格按主机隔离的类型（pane 档） */
export const isHostType = (t: TabType): boolean => TAB_KINDS[t].host === "pane";

/** 「+」菜单里的类型，顺序同事实表 */
export const CREATABLE_TABS: readonly TabType[] = TYPES.filter(
  (t) => TAB_KINDS[t].creatable,
);
