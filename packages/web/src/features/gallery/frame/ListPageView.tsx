import { useState } from "react";
import {
  Button,
  Card,
  Chip,
  InlineNotice,
  Menu,
  SearchBox,
  Table,
  Td,
  Th,
} from "../../../ui";
import { PlusIcon } from "../../../ui/icons";
import { PageTabs } from "../../settings/frame/PageTabs";
import { SettingsShell } from "./Shell";

type Row = {
  name: string;
  desc: string;
  meta: string;
  ref: string;
  active?: boolean;
};

const AGENTS: Row[] = [
  {
    name: "coder-full",
    desc: "完整编码助手：身份、工具规则、文档、环境与交付提醒",
    meta: "能力不限制",
    ref: "被 3 个会话引用",
  },
  {
    name: "reviewer",
    desc: "只评审不改代码",
    meta: "6 项能力",
    ref: "未被引用",
  },
  {
    name: "local-qwen",
    desc: "本地 Qwen 专用，短提示词、不带子代理",
    meta: "9 项能力",
    ref: "被 1 个会话引用",
  },
  {
    name: "doc-writer",
    desc: "写文档与变更说明，只读代码",
    meta: "5 项能力",
    ref: "未被引用",
  },
];
const MODES: Row[] = [
  {
    name: "plan",
    desc: "只读规划：不改文件，先给方案",
    meta: "只读工具集",
    ref: "种子模式",
  },
  {
    name: "review",
    desc: "评审：读代码、给意见",
    meta: "只读工具集",
    ref: "种子模式",
  },
];
const GLOBAL_MD: Row[] = [
  {
    name: "我的习惯 v3",
    desc: "中文回复；改代码前先说明；提交信息写英文",
    meta: "4 张卡片",
    ref: "生效中",
    active: true,
  },
  {
    name: "我的习惯 v2",
    desc: "中文回复；提交信息写英文",
    meta: "3 张卡片",
    ref: "未激活",
  },
];
const PROJECT_MD: Row[] = [
  {
    name: "前端项目模板",
    desc: "React + Tailwind；组件放 ui/；测试用 vitest",
    meta: "5 张卡片",
    ref: "创建工作区时可选",
  },
  {
    name: "后端项目模板",
    desc: "FastAPI；依赖用 uv；测试放 tests/",
    meta: "4 张卡片",
    ref: "创建工作区时可选",
  },
];
const EXTRA: Row[] = [
  {
    name: "本地模型部署限制",
    desc: "在本地部署的模型上：不要并行调用工具，回复保持简短",
    meta: "按模型路由",
    ref: "生效中",
    active: true,
  },
];
const TOOLS: [string, string, string, string][] = [
  ["read", "读取文件", "开", "内放行 · 外审批"],
  ["bash", "执行命令", "开", "内审批 · 外审批"],
  ["edit", "编辑文件", "开", "内放行 · 外审批"],
  ["grep", "按内容搜索", "—", "内放行 · 外审批"],
];

const KINDS = {
  agent: { rows: AGENTS, add: "新建 Agent", ph: "搜索 Agent" },
  mode: { rows: MODES, add: "新建模式", ph: "搜索模式" },
  gmd: { rows: GLOBAL_MD, add: "新建版本", ph: "搜索版本" },
  pmd: { rows: PROJECT_MD, add: "新建模板", ph: "搜索模板" },
  extra: { rows: EXTRA, add: "新建版本", ph: "搜索版本" },
} as const;
type Kind = keyof typeof KINDS;

// 样张：列表页（提示词与能力）。页签文字、搜索框、卡片的左缘都落在页面留白上，与主从页同一个 x。
export function ListPageView() {
  const [tab, setTab] = useState("agent");
  const [q, setQ] = useState("");
  const kind = tab in KINDS ? (tab as Kind) : null;
  const cfg = kind ? KINDS[kind] : null;
  return (
    <SettingsShell current="studio">
      <div className="st-page">
        <PageTabs
          idBase="pfl"
          aria-label="提示词与能力视图"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "gmd", label: "全局 AGENTS.md" },
            { id: "pmd", label: "项目 AGENTS.md" },
            { id: "extra", label: "全局附加提示词", count: 1 },
            { id: "agent", label: "Agent", count: AGENTS.length },
            { id: "mode", label: "模式", count: MODES.length },
            { id: "tools", label: "工具" },
            { id: "cards", label: "卡片", count: 14 },
          ]}
        />
        <div className="st-scroll">
          <div className="st-col">
            {kind === "gmd" && (
              <InlineNotice tone="warn" className="gl-note">
                磁盘上的 <span className="t-mono">~/.ys/AGENTS.md</span>{" "}
                比生效版本新（有人改过它）。激活别的版本会覆盖它，到时先问你。
              </InlineNotice>
            )}
            {kind === "pmd" && (
              <InlineNotice className="gl-note">
                这里只存模板：创建工作区时选一个作为起点，写进主目录的{" "}
                <span className="t-mono">AGENTS.md</span>，之后归项目自己。
              </InlineNotice>
            )}
            {cfg && (
              <>
                <div className="gl-bar2">
                  <SearchBox
                    aria-label="搜索"
                    placeholder={cfg.ph}
                    className="gl-search"
                    value={q}
                    onChange={setQ}
                  />
                  <Button icon={<PlusIcon size={14} />}>{cfg.add}</Button>
                </div>
                <div className="gl-cardgrid">
                  {cfg.rows
                    .filter((r) => r.name.includes(q))
                    .map((r) => (
                      <Card
                        key={r.name}
                        title={r.name}
                        {...(r.active
                          ? {
                              badge: (
                                <Chip tone="live" dot>
                                  生效中
                                </Chip>
                              ),
                            }
                          : {})}
                        description={r.desc}
                        meta={
                          <>
                            <span>{r.meta}</span>
                            {!r.active && <Chip>{r.ref}</Chip>}
                          </>
                        }
                        actions={
                          <Menu
                            label={`${r.name} 的操作`}
                            items={[
                              ...(kind === "gmd" && !r.active
                                ? [
                                    {
                                      id: "on",
                                      label: "激活",
                                      onSelect: () => {},
                                    },
                                  ]
                                : []),
                              { id: "copy", label: "复制", onSelect: () => {} },
                              {
                                id: "del",
                                label: "删除",
                                tone: "danger" as const,
                                separatorBefore: true,
                                onSelect: () => {},
                              },
                            ]}
                          />
                        }
                        onOpen={() => {}}
                      />
                    ))}
                </div>
              </>
            )}
            {tab === "tools" && (
              <Table caption="工具" widths={["24%", "36%", "10%", "30%"]}>
                <thead>
                  <tr>
                    <Th>工具</Th>
                    <Th>说明</Th>
                    <Th>默认集合</Th>
                    <Th>出厂规则</Th>
                  </tr>
                </thead>
                <tbody>
                  {TOOLS.map(([n, d, on, r]) => (
                    <tr key={n}>
                      <Td mono>{n}</Td>
                      <Td>{d}</Td>
                      <Td>{on}</Td>
                      <Td>{r}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {tab === "cards" && (
              <p className="t-aux">
                卡片库沿用现有设计，这里只演示页签与留白。
              </p>
            )}
          </div>
        </div>
      </div>
    </SettingsShell>
  );
}
