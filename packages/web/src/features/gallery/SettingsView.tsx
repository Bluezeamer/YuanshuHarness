import { type ReactNode, useState } from "react";
import {
  Button,
  Card,
  Chip,
  IconButton,
  ListRow,
  SearchBox,
  Segmented,
  Select,
  SettingRow,
  Slider,
  Switch,
  Tabs,
} from "../../ui";
import {
  BackIcon,
  BlocksIcon,
  CopyIcon,
  DefaultsIcon,
  PlusIcon,
  ProvidersIcon,
  RemoteIcon,
  ToolsIcon,
  TrashIcon,
  VariablesIcon,
} from "../../ui/icons";

const NAV = [
  { id: "providers", label: "供应商与模型", icon: ProvidersIcon },
  { id: "remote", label: "远程连接", icon: RemoteIcon },
  { id: "variables", label: "隐私变量", icon: VariablesIcon },
  { id: "tools", label: "工具与能力", icon: ToolsIcon },
  { id: "presets", label: "提示词与能力", icon: BlocksIcon },
  { id: "defaults", label: "默认值设置", icon: DefaultsIcon },
] as const;

const AGENTS = [
  {
    n: "coder-full",
    d: "完整的编码代理：读写文件、执行命令、编排子代理",
    caps: 14,
    refs: 5,
    tag: "默认",
  },
  { n: "reviewer", d: "只评审不改代码，输出问题清单与风险", caps: 6, refs: 1 },
  { n: "writer", d: "写作与文档整理，不执行命令", caps: 4, refs: 0 },
  {
    n: "local-qwen",
    d: "面向本地部署模型：并发与思考强度的约束已写入提示词",
    caps: 10,
    refs: 2,
    route: 2,
  },
  {
    n: "researcher",
    d: "联网检索与资料整理，结果带来源链接",
    caps: 9,
    refs: 0,
  },
  { n: "sandbox", d: "受限环境，只开放文件读写", caps: 3, refs: 0 },
];

const TABS = [
  { id: "g", label: "全局 AGENTS.md", count: 3 },
  { id: "p", label: "项目 AGENTS.md", count: 2 },
  { id: "a", label: "Agent", count: 6 },
  { id: "m", label: "模式", count: 3 },
  { id: "t", label: "工具" },
  { id: "c", label: "卡片", count: 24 },
];

function Presets() {
  const [tab, setTab] = useState("a");
  const [q, setQ] = useState("");
  return (
    <div className="gl-page">
      <div className="gl-head">
        <div>
          <div className="t-page">提示词与能力</div>
          <div className="t-aux">决定 agent 是谁、能做什么、怎么回应</div>
        </div>
        <Button variant="primary" size="lg" icon={<PlusIcon />}>
          新建 Agent
        </Button>
      </div>
      <Tabs
        tabs={TABS}
        value={tab}
        onChange={setTab}
        idBase="gl-presets"
        aria-label="提示词分类"
      />
      <div className="gl-bar2">
        <SearchBox
          className="gl-search"
          value={q}
          onChange={setQ}
          placeholder="搜索 Agent"
          aria-label="搜索 Agent"
        />
        <span className="t-aux">按最近修改排序</span>
      </div>
      <div className="gl-grid">
        {AGENTS.filter((a) => a.n.includes(q)).map((a) => (
          <Card
            key={a.n}
            title={a.n}
            badge={a.tag && <Chip tone="on">{a.tag}</Chip>}
            description={a.d}
            onOpen={() => {}}
            meta={
              <>
                <span>{a.caps} 项能力</span>
                {a.route && <Chip tone="accent">含 {a.route} 条路由</Chip>}
                <span>{a.refs ? `${a.refs} 个会话在用` : "未被引用"}</span>
              </>
            }
            actions={
              <>
                <IconButton label="复制为新 Agent" icon={<CopyIcon />} />
                <IconButton
                  label={a.refs ? `被 ${a.refs} 个会话引用，不能删除` : "删除"}
                  icon={<TrashIcon />}
                  disabled={a.refs > 0}
                />
              </>
            }
          />
        ))}
      </div>
    </div>
  );
}

const THINK = [
  { value: "off", label: "关闭" },
  { value: "low", label: "low" },
  { value: "xhigh", label: "xhigh" },
];
const PERM = [
  { value: "rules", label: "规则" },
  { value: "auto", label: "模型", disabled: true },
  { value: "full", label: "通过" },
];

function Defaults() {
  const [agent, setAgent] = useState("coder-full");
  const [model, setModel] = useState("qwen");
  const [think, setThink] = useState("low");
  const [perm, setPerm] = useState("rules");
  const [size, setSize] = useState(16);
  const [compress, setCompress] = useState(true);
  return (
    <div className="gl-page">
      <div className="gl-head">
        <div>
          <div className="t-page">默认值设置</div>
          <div className="t-aux">新建会话时自动套用；已有会话不受影响</div>
        </div>
      </div>
      <div className="gl-grp">
        <div className="t-group">新会话</div>
        <SettingRow
          label="默认 Agent"
          description="新建对话时自动选中，仍可在创建时换"
        >
          {(c) => (
            <Select
              {...c}
              value={agent}
              onChange={setAgent}
              options={[
                { value: "coder-full", label: "coder-full", hint: "默认" },
                { value: "reviewer", label: "reviewer" },
                { value: "local-qwen", label: "local-qwen" },
              ]}
            />
          )}
        </SettingRow>
        <SettingRow label="默认模型" description="供应商与模型">
          {(c) => (
            <div className="gl-ctl">
              {model !== "qwen" && <Chip tone="accent">已修改</Chip>}
              {model !== "qwen" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setModel("qwen")}
                >
                  恢复
                </Button>
              )}
              <Select
                {...c}
                value={model}
                onChange={setModel}
                options={[
                  { value: "qwen", label: "Qwen3.8-27B", hint: "qwen27b" },
                  {
                    value: "claude",
                    label: "claude-sonnet-5",
                    hint: "anthropic",
                  },
                ]}
              />
            </div>
          )}
        </SettingRow>
        <SettingRow label="思考强度" description="只列出该模型支持的档位">
          <Segmented
            aria-label="思考强度"
            options={THINK}
            value={think}
            onChange={setThink}
          />
        </SettingRow>
      </div>
      <div className="gl-grp">
        <div className="t-group">权限</div>
        <SettingRow label="默认档位" description="「模型」档需要先配置审批模型">
          <Segmented
            aria-label="默认档位"
            options={PERM}
            value={perm}
            onChange={setPerm}
          />
        </SettingRow>
      </div>
      <div className="gl-grp">
        <div className="t-group">界面</div>
        <SettingRow
          label="基准字号"
          description="只放大要读的内容，侧栏与标签栏保持原尺寸"
        >
          <div className="gl-ctl-slider">
            <Slider
              aria-label="基准字号"
              min={12}
              max={22}
              value={size}
              onChange={setSize}
            />
            <span className="t-mono">{size}</span>
          </div>
        </SettingRow>
        <SettingRow
          label="图片自动压缩"
          description="发送前把图片缩到模型接受的尺寸"
        >
          <div className="gl-ctl">
            <Switch
              checked={compress}
              onChange={setCompress}
              aria-label="图片自动压缩"
            />
          </div>
        </SettingRow>
      </div>
    </div>
  );
}

// 设置页外壳：左导航用 ListRow，右边是滚动区。样张里的 Studio 视图也套它。
export function SettingsFrame({
  current,
  children,
}: {
  current: string;
  children: ReactNode;
}) {
  return (
    <div className="gl-settings">
      <nav className="gl-nav" aria-label="设置">
        <div className="gl-nav-h">
          <IconButton label="返回" icon={<BackIcon />} />
          <span className="t-entry">设置</span>
        </div>
        {NAV.map(({ id, label, icon: Icon }) => (
          <ListRow
            key={id}
            label={label}
            lead={<Icon />}
            current={current === id}
          />
        ))}
      </nav>
      <div className="gl-scroll">{children}</div>
    </div>
  );
}

// 样张 2：设置页。提示词页是预设卡片，默认值页是「名字在左、控件在右」的行。
export function SettingsView() {
  const [page, setPage] = useState<string>("presets");
  return (
    <div className="gl-settings">
      <nav className="gl-nav" aria-label="设置">
        <div className="gl-nav-h">
          <IconButton label="返回" icon={<BackIcon />} />
          <span className="t-entry">设置</span>
        </div>
        {NAV.map(({ id, label, icon: Icon }) => (
          <ListRow
            key={id}
            label={label}
            lead={<Icon />}
            current={page === id}
            onClick={() => setPage(id)}
          />
        ))}
      </nav>
      <div className="gl-scroll">
        {page === "defaults" ? <Defaults /> : <Presets />}
      </div>
    </div>
  );
}
