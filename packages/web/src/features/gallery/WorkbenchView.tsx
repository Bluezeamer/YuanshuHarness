import { useState } from "react";
import {
  Button,
  Dot,
  FileTypeIcon,
  IconButton,
  ListRow,
  ProgressBar,
  ReadBar,
  TabStrip,
  Textarea,
} from "../../ui";
import {
  ArrowUpIcon,
  ChatIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FileIcon,
  FolderIcon,
  MoreIcon,
  PlusIcon,
  RefreshIcon,
  StopIcon,
  TerminalIcon,
} from "../../ui/icons";

type Tone = "live" | "warn" | "accent" | "danger";
type Session = {
  name: string;
  tone?: Tone;
  unread?: boolean;
  derived?: boolean;
};
type Workspace = {
  name: string;
  path?: string;
  open: boolean;
  agg: [Tone, number][];
  count?: number;
  sessions: Session[];
};

// 状态点：执行中绿色脉动、待处理琥珀；新结果用右侧的蓝点
const WORKSPACES: Workspace[] = [
  {
    name: "yuanshu-harness",
    path: "~/Yuanshu-harness  ·  +1 目录",
    open: true,
    agg: [
      ["warn", 1],
      ["live", 1],
    ],
    sessions: [
      { name: "重构提示词送达", tone: "live" },
      { name: "权限矩阵讨论", tone: "warn", unread: true },
      { name: "修复 biome 报错" },
      { name: "修复 biome 报错 · 分支1", derived: true },
      { name: "工作区设计", unread: true },
    ],
  },
  { name: "blank-start", open: false, agg: [], count: 3, sessions: [] },
  {
    name: "local27b-test",
    open: false,
    agg: [["danger", 1]],
    count: 2,
    sessions: [],
  },
];

export function Rail() {
  const [open, setOpen] = useState<Record<string, boolean>>(
    Object.fromEntries(WORKSPACES.map((w) => [w.name, w.open])),
  );
  const [cur, setCur] = useState("重构提示词送达");
  return (
    <aside className="gl-rail">
      <div className="gl-rail-h">
        <span className="t-block">元枢</span>
        <IconButton label="新建工作区" icon={<PlusIcon />} />
      </div>
      <nav className="gl-rail-list" aria-label="工作区">
        {WORKSPACES.map((w) => (
          <div key={w.name}>
            <ListRow
              label={w.name}
              lead={open[w.name] ? <ChevronDownIcon /> : <ChevronRightIcon />}
              trail={
                <span className="gl-agg">
                  {w.agg.map(([tone, n]) => (
                    <span key={tone}>
                      <Dot size="sm" tone={tone} />
                      {n}
                    </span>
                  ))}
                  {w.count !== undefined && <span>{w.count}</span>}
                </span>
              }
              onClick={() => setOpen((o) => ({ ...o, [w.name]: !o[w.name] }))}
            />
            {open[w.name] && w.path && (
              <div className="gl-path t-mono">{w.path}</div>
            )}
            {open[w.name] && (
              <div className="gl-subs">
                {w.sessions.map((s) => (
                  <ListRow
                    key={s.name}
                    className={s.derived ? "gl-derived" : undefined}
                    size="compact"
                    label={s.name}
                    sub={s.derived ? "↳ 从某一轮分出" : undefined}
                    lead={
                      <span className="gl-stat">
                        {s.tone && (
                          <Dot
                            size="sm"
                            tone={s.tone}
                            motion={s.tone === "live" ? "pulse" : undefined}
                          />
                        )}
                      </span>
                    }
                    trail={s.unread && <Dot size="sm" tone="accent" />}
                    current={cur === s.name}
                    onClick={() => setCur(s.name)}
                    actions={
                      <IconButton label="更多" size="sm" icon={<MoreIcon />} />
                    }
                  />
                ))}
                {w.path && (
                  <ListRow
                    className="gl-new"
                    size="compact"
                    label="新对话"
                    lead={<PlusIcon />}
                  />
                )}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="gl-rail-f">
        <Button variant="ghost" size="sm">
          设置
        </Button>
        <span className="t-mono">本机</span>
      </div>
    </aside>
  );
}

function Thread() {
  const [more, setMore] = useState(true);
  return (
    <div className="gl-thread">
      <div className="gl-col">
        <div className="gl-user t-read">
          把 3.1 到 3.6 整理成两份现行文档，别漏了遗留项。
        </div>
        <div className="gl-steps">
          <ListRow
            size="compact"
            label="读取了 6 个文件"
            lead={<ChevronRightIcon />}
            trail={<span className="t-mono">1.2s</span>}
          />
        </div>
        <p className="t-read">
          我先把讨论记录里的结论归并，再核对旧草稿的每个条目去向，确认没有被推翻的旧说法残留。
        </p>
        <div className="gl-steps">
          <ListRow
            size="compact"
            label="运行了 2 条命令"
            lead={more ? <ChevronDownIcon /> : <ChevronRightIcon />}
            trail={<span className="t-mono">3.4s</span>}
            onClick={() => setMore(!more)}
          />
          {more && (
            <>
              <div className="gl-step">
                <Dot tone="live" />
                <span className="t-plain">bash</span>
                <span className="gl-step-arg t-code">
                  wc -l docs/model/prompt.md docs/model/prompt-delivery.md
                </span>
                <span className="t-mono">0.1s</span>
              </div>
              <div className="gl-step">
                <Dot tone="danger" />
                <span className="t-plain">bash</span>
                <span className="gl-step-arg t-code">pnpm lint</span>
                <span className="t-mono">3.3s</span>
              </div>
              <pre className="gl-out t-code">
                <span className="gl-bad">error</span>
                {"  lint/style/useConst  packages/web/src/GraphCanvas.tsx:84\n"}
                {"Found 51 errors."}
              </pre>
            </>
          )}
        </div>
        <p className="t-read">
          两份文档已经写好：<span className="t-code">prompt.md</span> 是定义，
          <span className="t-code">prompt-delivery.md</span> 是送达。lint 有 51
          个错误，是之前就有的，和这次改动无关。
        </p>
        <div className="gl-live">
          <Dot tone="live" motion="pulse" />
          <span className="t-aux">正在运行 bash · 12s</span>
          <ProgressBar value={null} label="正在运行" />
        </div>
      </div>
    </div>
  );
}

function Composer() {
  return (
    <div className="gl-dock">
      <div className="gl-comp">
        <Textarea
          className="gl-comp-in"
          rows={1}
          aria-label="给元枢发消息"
          placeholder="给元枢发消息…"
        />
        <div className="gl-comp-b">
          <IconButton label="附件" icon={<PlusIcon />} />
          <Button variant="ghost" size="sm" icon={<ChevronDownIcon />}>
            plan
          </Button>
          <span className="gl-sp" />
          <Button variant="ghost" size="sm" icon={<ChevronDownIcon />}>
            Qwen3.8-27B · low
          </Button>
          <Button
            variant="primary"
            size="sm"
            aria-label="停止"
            icon={<StopIcon />}
          />
          <Button
            variant="outline"
            size="sm"
            aria-label="发送"
            icon={<ArrowUpIcon />}
          />
        </div>
      </div>
    </div>
  );
}

const CHAT_TABS = [
  { id: "a", title: "重构提示词送达", icon: <ChatIcon /> },
  { id: "b", title: "权限矩阵讨论", icon: <ChatIcon />, temp: true },
];
const FILE_TABS = [
  { id: "files", title: "文件", icon: <FolderIcon />, closable: false },
  { id: "md", title: "prompt.md", icon: <FileIcon />, temp: true },
  { id: "term", title: "终端", icon: <TerminalIcon />, closable: false },
];

type FileItem = {
  folder?: boolean;
  name: string;
  level: number;
  git?: "M" | "U";
  time?: string;
  sel?: boolean;
};
const FILES: FileItem[] = [
  { folder: true, name: "docs", level: 0 },
  { name: "prompt-delivery.md", level: 1, git: "U", time: "刚刚" },
  { name: "prompt.md", level: 1, git: "M", time: "2 分钟", sel: true },
  { folder: true, name: "src", level: 0 },
  { name: "App.tsx", level: 1, git: "M", time: "5 分钟" },
  { name: "main.ts", level: 1, time: "昨天" },
  { name: "main.test.ts", level: 1, time: "昨天" },
  { name: "styles.css", level: 1, time: "2 天" },
  { folder: true, name: "scripts", level: 0 },
  { folder: true, name: "public", level: 0 },
  { folder: true, name: "node_modules", level: 0 },
  { name: "package.json", level: 0, git: "M", time: "1 小时" },
  { name: "tsconfig.json", level: 0, time: "3 天" },
  { name: "Dockerfile", level: 0, time: "3 天" },
  { name: ".gitignore", level: 0, time: "1 周" },
  { name: "logo.png", level: 0, time: "1 周" },
  { name: "README.md", level: 0, time: "1 周" },
  { name: "data.csv", level: 0, time: "2 周" },
  { name: "notes.txt", level: 0, time: "2 周" },
  { name: "deploy.sh", level: 0, time: "3 周" },
  { name: "archive.zip", level: 0, time: "1 月" },
  { name: "LICENSE", level: 0, time: "1 月" },
];

export function FilesPane() {
  const [tab, setTab] = useState("files");
  return (
    <section className="gl-pane">
      <TabStrip
        tabs={FILE_TABS}
        value={tab}
        onChange={setTab}
        onClose={() => {}}
        onAdd={() => {}}
        addLabel="新建标签"
        aria-label="文件窗格标签"
      />
      <div className="gl-crumb">
        <span className="gl-crumb-path t-mono">
          ~/Yuanshu-harness/docs/model
        </span>
        <IconButton label="刷新" icon={<RefreshIcon />} />
        <IconButton label="新建" icon={<PlusIcon />} />
      </div>
      <div className="gl-files">
        {FILES.map((f) => (
          <ListRow
            key={`${f.level}-${f.name}`}
            size="compact"
            style={{ marginLeft: f.level * 16 }}
            label={f.name}
            lead={
              <>
                {f.folder ? (
                  <ChevronRightIcon size={12} />
                ) : (
                  <span className="gl-nochev" />
                )}
                <FileTypeIcon name={f.name} dir={f.folder} />
              </>
            }
            trail={
              <span className="gl-meta">
                <span className="gl-git t-mono" data-git={f.git}>
                  {f.git}
                </span>
                <span className="gl-time t-mono">{f.time}</span>
              </span>
            }
            current={f.sel}
            actions={
              <>
                <IconButton label="复制路径" icon={<CopyIcon />} />
                <IconButton label="更多" icon={<MoreIcon />} />
              </>
            }
          />
        ))}
      </div>
    </section>
  );
}

function StatusBar() {
  return (
    <footer className="gl-status t-aux">
      <span className="gl-it">
        <FolderIcon size={13} />
        本机 · ~/Yuanshu-harness
      </span>
      <i className="gl-sepv" />
      <span className="gl-it">规则审批</span>
      <span className="gl-sp" />
      <span className="gl-it">
        上下文
        <ReadBar
          value={94.6}
          max={210}
          label="上下文占用"
          text="94.6k / 210k"
        />
      </span>
      <i className="gl-sepv" />
      <span className="gl-it">
        缓存命中 <span className="t-mono">99%</span>
      </span>
    </footer>
  );
}

// 样张 3：工作台。左轨是 ListRow（工作区路径行、状态点、分支缩进、新对话），
// 中间是对话窗格，右边是文件窗格（三个标签：文件 / 临时预览 / 终端），底部状态栏。
export function WorkbenchView() {
  const [tab, setTab] = useState("a");
  return (
    <div className="gl-wb">
      <Rail />
      <div className="gl-stage">
        <div className="gl-panes">
          <section className="gl-pane">
            <TabStrip
              tabs={CHAT_TABS}
              value={tab}
              onChange={setTab}
              onClose={() => {}}
              onAdd={() => {}}
              addLabel="新对话"
              aria-label="对话窗格标签"
            />
            <Thread />
            <Composer />
          </section>
          <FilesPane />
        </div>
        <StatusBar />
      </div>
    </div>
  );
}
