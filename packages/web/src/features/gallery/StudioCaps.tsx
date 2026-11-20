import { useState } from "react";
import {
  Button,
  Chip,
  Dot,
  InlineNotice,
  Input,
  ListRow,
  SearchBox,
  Segmented,
  Select,
  SettingRow,
} from "../../ui";
import { CheckIcon } from "../../ui/icons";

interface Cap {
  id: string;
  name: string;
  desc: string;
  trail?: React.ReactNode;
}
interface CapGroup {
  title: string;
  note?: string;
  items: Cap[];
}

const GROUPS: CapGroup[] = [
  {
    title: "内置工具",
    note: "共 22 个，样张只列一部分",
    items: [
      {
        id: "tool:read",
        name: "read",
        desc: "读取文件",
        trail: <Chip>只读</Chip>,
      },
      {
        id: "tool:grep",
        name: "grep",
        desc: "按内容搜索",
        trail: <Chip>只读</Chip>,
      },
      {
        id: "tool:find",
        name: "find",
        desc: "按名称查找文件",
        trail: <Chip>只读</Chip>,
      },
      { id: "tool:ls", name: "ls", desc: "列目录", trail: <Chip>只读</Chip> },
      { id: "tool:write", name: "write", desc: "写入文件" },
      { id: "tool:edit", name: "edit", desc: "编辑文件" },
      { id: "tool:bash", name: "bash", desc: "执行命令" },
      {
        id: "tool:transfer_files",
        name: "transfer_files",
        desc: "在两个目录之间传输文件（可跨主机）",
      },
    ],
  },
  {
    title: "能力单元",
    note: "整体开关，不拆到单个工具",
    items: [
      {
        id: "unit:subagent",
        name: "子代理",
        desc: "派发、等待、打断子代理；可派发的清单在会话与默认配置里选",
      },
    ],
  },
  {
    title: "技能",
    items: [
      {
        id: "skill:code-review",
        name: "code-review",
        desc: "代码审查流程",
        trail: "全局",
      },
      {
        id: "skill:commit-helper",
        name: "commit-helper",
        desc: "按规范生成提交信息",
        trail: "全局",
      },
      {
        id: "skill:harness-docs",
        name: "harness-docs",
        desc: "查本 harness 的文档",
        trail: "全局",
      },
    ],
  },
  {
    title: "MCP 服务",
    items: [
      {
        id: "mcp:filesystem",
        name: "filesystem",
        desc: "文件系统访问",
        trail: (
          <span className="gl-tr">
            <Dot tone="live" /> 就绪 · 11 工具
          </span>
        ),
      },
      {
        id: "mcp:github",
        name: "github",
        desc: "仓库、议题与 PR",
        trail: (
          <span className="gl-tr">
            <Dot tone="live" /> 就绪 · 3 工具
          </span>
        ),
      },
      {
        id: "mcp:linear",
        name: "linear",
        desc: "任务管理",
        trail: (
          <span className="gl-tr">
            <Dot tone="warn" /> 握手失败
          </span>
        ),
      },
    ],
  },
];

const INITIAL = [
  "tool:read",
  "tool:grep",
  "tool:find",
  "tool:ls",
  "tool:write",
  "tool:edit",
  "tool:bash",
  "tool:transfer_files",
  "unit:subagent",
  "skill:code-review",
  "skill:commit-helper",
  "mcp:filesystem",
  "mcp:github",
];

// 能力页：Agent 的基线。「不限制」或「指定清单」；指定时逐项勾选。会话可以在这个基线上增减。
export function CapsTab() {
  const [mode, setMode] = useState<"all" | "pick">("pick");
  const [on, setOn] = useState<string[]>(INITIAL);
  const [q, setQ] = useState("");
  const total = GROUPS.reduce((a, g) => a + g.items.length, 0);
  const toggle = (id: string) =>
    setOn((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );
  return (
    <div className="gl-caps">
      <div className="gl-caps-bar">
        <Segmented
          aria-label="能力范围"
          options={[
            { value: "all", label: "不限制" },
            { value: "pick", label: "指定清单" },
          ]}
          value={mode}
          onChange={setMode}
        />
        <span className="t-aux">
          {mode === "all"
            ? "全部内置工具 + 目录已分发的技能与 MCP"
            : `已选 ${on.length} / ${total}`}
        </span>
        <span className="gl-sp" />
        <SearchBox
          className="gl-search"
          value={q}
          onChange={setQ}
          placeholder="搜能力"
          aria-label="搜索能力"
        />
      </div>
      <InlineNotice>
        这是 Agent
        的基线：会话在它上面可以增减，改动单独记在会话里，随时能恢复成这份基线。框架工具（call_tool、ask_user、todo_write、后台任务等）始终可用，不在这里；插件注册的工具由插件开关决定。
      </InlineNotice>
      <div className="gl-caps-body" data-off={mode === "all" || undefined}>
        {GROUPS.map((g) => {
          const items = g.items.filter(
            (c) => q === "" || `${c.name}${c.desc}`.includes(q),
          );
          if (items.length === 0) return null;
          const n = items.filter((c) => on.includes(c.id)).length;
          return (
            <section key={g.title} className="gl-caps-grp">
              <div className="gl-caps-h">
                <span className="t-group">{g.title}</span>
                <span className="t-aux">
                  {n} / {items.length}
                  {g.note && ` · ${g.note}`}
                </span>
                <span className="gl-sp" />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setOn((cur) => [
                      ...cur.filter((x) => !items.some((c) => c.id === x)),
                      ...items.map((c) => c.id),
                    ])
                  }
                >
                  全选
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setOn((cur) =>
                      cur.filter((x) => !items.some((c) => c.id === x)),
                    )
                  }
                >
                  清空
                </Button>
              </div>
              {items.map((c) => {
                const checked = on.includes(c.id);
                return (
                  <ListRow
                    key={c.id}
                    size="compact"
                    lead={
                      <span className="gl-ck" data-on={checked || undefined}>
                        {checked && <CheckIcon />}
                      </span>
                    }
                    label={
                      <>
                        <span className="t-mono">{c.name}</span>
                        <span className="gl-cap-d t-aux">{c.desc}</span>
                      </>
                    }
                    trail={c.trail}
                    onClick={() => toggle(c.id)}
                  />
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}

// 设定页：名称、描述、默认模型与思考强度（都可以不指定）。
export function BasicsTab() {
  const [model, setModel] = useState("");
  const [think, setThink] = useState("");
  return (
    <div className="gl-caps">
      <SettingRow label="名称" description="创建会话时在下拉里看到的名字">
        {(c) => <Input {...c} defaultValue="coder-full" />}
      </SettingRow>
      <SettingRow label="描述" description="列表卡片上的一句话">
        {(c) => (
          <Input
            {...c}
            defaultValue="完整的编码代理：读写文件、执行命令、编排子代理"
          />
        )}
      </SettingRow>
      <SettingRow
        label="默认模型"
        description="创建时手选的优先；其次是这里；再其次是工作区、全局的默认配置。探索类 Agent 可以固定用小模型省成本"
      >
        {(c) => (
          <Select
            {...c}
            value={model}
            onChange={setModel}
            options={[
              { value: "", label: "不指定", hint: "跟随默认配置" },
              { value: "qwen", label: "Qwen3.8-27B", hint: "本地部署" },
              { value: "claude", label: "claude-sonnet-5", hint: "Anthropic" },
            ]}
          />
        )}
      </SettingRow>
      <SettingRow label="思考强度" description="只列该模型支持的档位">
        <Segmented
          aria-label="思考强度"
          options={[
            { value: "", label: "不指定" },
            { value: "low", label: "low" },
            { value: "high", label: "high" },
            { value: "xhigh", label: "xhigh" },
          ]}
          value={think}
          onChange={setThink}
        />
      </SettingRow>
      <SettingRow
        label="删除这个 Agent"
        description="5 个会话正在用它，不能删。先删掉这些会话，或建一个新的 Agent 替代"
      >
        <Button variant="danger" disabled>
          删除
        </Button>
      </SettingRow>
    </div>
  );
}
