// 左轨样张的静态数据（形状见 workspace/sidebar/model.ts）。
import type { RemovalPreview } from "../../../api/workspaces";
import type { Group, Ws } from "../../workspace/sidebar/model";

export const GROUPS: Group[] = [
  { id: "g-main", name: "主线", tone: 1 },
  { id: "g-lab", name: "实验", tone: 3 },
];

export const WORKSPACES: Ws[] = [
  {
    id: "w-harness",
    name: "yuanshu-harness",
    path: "~/work/yuanshu-harness",
    extraDirs: 1,
    group: "g-main",
    sessions: [
      {
        id: "s-prompt",
        title: "重构提示词送达",
        status: "running",
        ago: ["2", "分钟"],
      },
      {
        id: "s-perm",
        title: "权限矩阵讨论",
        status: "blocked",
        unread: "result",
        ago: ["5", "分钟"],
      },
      {
        id: "s-biome",
        title: "修复 biome 报错",
        status: "idle",
        ago: ["1", "小时"],
      },
      {
        id: "s-biome-1",
        title: "修复 biome 报错 · 分支1",
        status: "idle",
        parent: "s-biome",
        ago: ["40", "分钟"],
      },
      {
        id: "s-biome-2",
        title: "修复 biome 报错 · 分支2",
        status: "idle",
        parent: "s-biome",
        ago: ["12", "分钟"],
      },
      {
        id: "s-design",
        title: "工作区设计",
        status: "idle",
        unread: "result",
        ago: ["1", "天"],
      },
      {
        id: "s-probe",
        title: "提示词探针实验",
        status: "idle",
        archived: true,
        ago: ["6", "天"],
      },
      {
        id: "s-canvas",
        title: "画布初稿",
        status: "idle",
        archived: true,
        ago: ["9", "天"],
      },
    ],
  },
  {
    id: "w-docs",
    name: "docs-site",
    path: "~/work/docs-site",
    group: "g-main",
    sessions: [
      {
        id: "s-terms",
        title: "术语表整理",
        status: "idle",
        ago: ["3", "小时"],
      },
      {
        id: "s-align",
        title:
          "帮我看看 tmp/ui-review 里几张样张哪里没对齐，顺便把刻度表也核一遍",
        status: "idle",
        ago: ["2", "天"],
      },
    ],
  },
  {
    id: "w-27b",
    name: "local27b-test",
    path: "~/lab/local27b",
    group: "g-lab",
    sessions: [
      {
        id: "s-stress",
        title: "并发上限压测",
        status: "idle",
        unread: "error",
        ago: ["20", "分钟"],
      },
      {
        id: "s-vllm",
        title: "vLLM 参数",
        status: "idle",
        ago: ["3", "天"],
      },
    ],
  },
  {
    id: "w-gpu",
    name: "gpu-box",
    path: "gpu-01:/data/train",
    group: "g-lab",
    sessions: [
      {
        id: "s-train",
        title: "训练脚本排错",
        status: "running",
        ago: ["", "刚刚"],
      },
      {
        id: "s-ckpt",
        title: "检查点清理",
        status: "idle",
        ago: ["2", "小时"],
      },
    ],
  },
  {
    id: "w-blank",
    name: "blank-start",
    path: "~/lab/blank-start",
    group: null,
    sessions: [
      { id: "s-b1", title: "草稿 A", status: "idle", ago: ["4", "天"] },
      { id: "s-b2", title: "草稿 B", status: "idle", ago: ["4", "天"] },
      { id: "s-b3", title: "草稿 C", status: "idle", ago: ["5", "天"] },
    ],
  },
  {
    id: "w-scratch",
    name: "scratch",
    path: "~/tmp/scratch",
    group: null,
    sessions: [],
  },
];

const TERMINALS: Record<string, number> = { "w-harness": 2, "w-gpu": 1 };

// 删除工作区的影响预览（形状同服务端 removal-preview），样张里用假数据。
export function previewOf(ws: Ws): RemovalPreview {
  const rich = ws.id === "w-harness";
  const directories = [
    {
      id: `${ws.id}-main`,
      name: ws.name,
      path: ws.path,
      environmentId: "local",
      removed: true,
      rules: rich ? 4 : 0,
      hooks: rich ? 1 : 0,
      capabilities: rich ? 3 : 0,
    },
    ...(ws.extraDirs
      ? [
          {
            id: `${ws.id}-extra`,
            name: "shared-docs",
            path: "~/work/shared-docs",
            environmentId: "local",
            removed: false,
            rules: 2,
            hooks: 0,
          },
        ]
      : []),
  ];
  return {
    running: ws.sessions.some((s) => s.status === "running"),
    sessions: ws.sessions.filter((s) => !s.archived).length,
    terminals: TERMINALS[ws.id] ?? 0,
    directories,
  };
}
