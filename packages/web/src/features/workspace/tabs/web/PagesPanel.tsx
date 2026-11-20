// 「页面」悬浮列表：工作区所有页面，「我的」置顶，其后每个会话一组（当前会话那组默认展开）；
// 底部「打开地址」。行上只放名字、地址与一个状态点，操作悬停才出现。
import { type RefObject, useMemo, useState } from "react";
import {
  Button,
  Dot,
  Empty,
  IconButton,
  InlineNotice,
  Input,
  ListRow,
  Popover,
} from "../../../../ui";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  ExternalIcon,
} from "../../../../ui/icons";
import type { ForwardView, PageView, PortView } from "../../browser";
import {
  addressOf,
  groupPages,
  type PageStatus,
  type PortRow,
  pageName,
  portLabel,
  portRows,
  statusOf,
  usedByNames,
} from "./model";

const DOT: Record<PageStatus, "live" | "accent" | "idle"> = {
  agent: "live",
  user: "accent",
  sleeping: "idle",
};
const STATUS_TEXT: Record<PageStatus, string> = {
  agent: "agent 在用",
  user: "你在操作",
  sleeping: "休眠",
};

export interface PagesPanelProps {
  open: boolean;
  onClose(): void;
  anchor: RefObject<HTMLElement | null>;
  pages: readonly PageView[];
  /** 此刻在监听的服务端口（检测到的） */
  ports: readonly PortView[];
  /** 已经转发给用户自己浏览器的服务（含手动添加、没被检测到的） */
  forwards: readonly ForwardView[];
  currentId: string | null;
  /** 窗口里正在显示的会话：它那一组默认展开 */
  anchorSession: string | null;
  titles: ReadonlyMap<string, string>;
  /** 会话的运行状态（只含执行中与待处理）：组头上画点，与左轨会话行同一套 */
  runStates: ReadonlyMap<string, "running" | "blocked">;
  hostName: (id: string) => string;
  onPick(page: PageView): void;
  onNewTab(page: PageView): void;
  onClosePage(page: PageView): void;
  /** 打开地址：返回失败原因（中文）；成功返回 null，由调用方切到新页面并收起列表 */
  onOpen(target: string): Promise<string | null>;
  /** 在用户自己的浏览器里打开这个端口（还没转发就先转发） */
  onForwardOpen(row: PortRow): void;
  onForwardCopy(forward: ForwardView): void;
  onForwardStop(forward: ForwardView): void;
  /** 手动添加转发（`3000`、`box:8080`）：返回失败原因（中文）；成功返回 null */
  onForwardAdd(target: string): Promise<string | null>;
}

export function PagesPanel(p: PagesPanelProps) {
  const groups = useMemo(() => groupPages(p.pages), [p.pages]);
  // null = 还没手动展开 / 折叠过，用默认：「我的」与当前会话那组展开
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const rows = useMemo(
    () => portRows(p.ports, p.forwards),
    [p.ports, p.forwards],
  );
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addText, setAddText] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const isOpen = (key: string) =>
    expanded ? expanded.has(key) : key === "mine" || key === p.anchorSession;
  const toggle = (key: string) => {
    const base = new Set(
      expanded ?? groups.filter((g) => isOpen(g.key)).map((g) => g.key),
    );
    if (!base.delete(key)) base.add(key);
    setExpanded(base);
  };

  const groupTitle = (sid: string | null) =>
    sid === null ? "我的" : (p.titles.get(sid) ?? `会话 ${sid.slice(0, 8)}`);

  const openTarget = async (raw: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const failed = await p.onOpen(raw);
    setBusy(false);
    if (failed) setError(failed);
    return !failed;
  };
  const open = async () => {
    const target = text.trim();
    if (target === "") return;
    if (await openTarget(target)) setText("");
  };
  const addForward = async () => {
    const target = addText.trim();
    if (target === "") return;
    setAdding(true);
    setAddError(null);
    const failed = await p.onForwardAdd(target);
    setAdding(false);
    if (failed) setAddError(failed);
    else setAddText("");
  };

  return (
    <Popover
      open={p.open}
      onClose={p.onClose}
      anchorRef={p.anchor}
      label="浏览器页面"
      width={360}
      className="ws-pg"
    >
      <div className="ws-pg-scroll">
        {p.pages.length === 0 && (
          <Empty compact title="还没有页面" description="在下面打开一个地址" />
        )}
        {p.pages.length > 0 &&
          groups.map((g) => {
            if (g.pages.length === 0) return null;
            const isGroupOpen = isOpen(g.key);
            return (
              <div key={g.key}>
                <ListRow
                  size="compact"
                  expanded={isGroupOpen}
                  lead={
                    isGroupOpen ? (
                      <ChevronDownIcon size={12} />
                    ) : (
                      <ChevronRightIcon size={12} />
                    )
                  }
                  label={groupTitle(g.sessionId)}
                  trail={
                    <span className="ws-pg-gtrail">
                      <GroupDot
                        state={
                          g.sessionId === null
                            ? null
                            : p.runStates.get(g.sessionId)
                        }
                      />
                      <span className="t-mono">{g.pages.length}</span>
                    </span>
                  }
                  onClick={() => toggle(g.key)}
                />
                {isGroupOpen &&
                  g.pages.map((page) => (
                    <PageRow key={page.id} page={page} panel={p} />
                  ))}
              </div>
            );
          })}
        <div>
          <div className="ws-pg-sec t-group">端口</div>
          {rows.map((row) => (
            <PortRowView
              key={row.key}
              row={row}
              panel={p}
              onOpen={openTarget}
            />
          ))}
          <div className="ws-pg-add">
            <Input
              value={addText}
              placeholder="转发端口：3000 或 主机名:端口"
              aria-label="添加转发端口"
              spellCheck={false}
              onChange={(e) => setAddText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addForward()}
            />
            <Button
              size="sm"
              loading={adding}
              onClick={() => void addForward()}
            >
              转发
            </Button>
          </div>
          {addError && (
            <InlineNotice tone="danger" className="ws-pg-note">
              {addError}
            </InlineNotice>
          )}
        </div>
      </div>
      <div className="ws-pg-open">
        <Input
          value={text}
          placeholder="地址、主机名:端口 或 文件路径"
          aria-label="打开地址"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void open()}
        />
        <Button size="sm" loading={busy} onClick={() => void open()}>
          打开
        </Button>
      </div>
      {error && (
        <InlineNotice tone="danger" className="ws-pg-note">
          {error}
        </InlineNotice>
      )}
    </Popover>
  );
}

// 与左轨会话行一致：只给执行中与待处理画点，待命不画
function GroupDot({
  state,
}: {
  state: "running" | "blocked" | null | undefined;
}) {
  if (state === "running")
    return <Dot tone="live" motion="pulse" label="执行中" />;
  if (state === "blocked") return <Dot tone="warn" label="待处理" />;
  return null;
}

function PortRowView({
  row,
  panel,
  onOpen,
}: {
  row: PortRow;
  panel: PagesPanelProps;
  onOpen(target: string): Promise<boolean>;
}) {
  const f = row.forward;
  return (
    <ListRow
      size="compact"
      lead={
        f ? (
          <Dot
            tone={f.listening ? "live" : "warn"}
            label={f.listening ? "转发中" : "转发端口被占用"}
          />
        ) : (
          <Dot tone="idle" label="未转发" />
        )
      }
      label={portLabel(row, panel.hostName)}
      sub={
        f
          ? f.listening
            ? `转发端口 ${f.localPort}`
            : "转发端口被占用"
          : undefined
      }
      actions={
        <>
          <IconButton
            size="sm"
            label="在本机浏览器打开"
            icon={<ExternalIcon size={12} />}
            onClick={() => panel.onForwardOpen(row)}
          />
          {f && (
            <>
              <IconButton
                size="sm"
                label="复制转发地址"
                icon={<CopyIcon size={12} />}
                onClick={() => panel.onForwardCopy(f)}
              />
              <IconButton
                size="sm"
                label="停止转发"
                icon={<CloseIcon size={12} />}
                onClick={() => panel.onForwardStop(f)}
              />
            </>
          )}
        </>
      }
      onClick={() => void onOpen(row.target)}
    />
  );
}

function PageRow({ page, panel }: { page: PageView; panel: PagesPanelProps }) {
  const status = statusOf(page);
  const used = usedByNames(
    page,
    (sid) => panel.titles.get(sid) ?? sid.slice(0, 8),
  );
  const address = addressOf(page.url, panel.hostName).text;
  return (
    <ListRow
      size="compact"
      current={page.id === panel.currentId}
      lead={<Dot tone={DOT[status]} label={STATUS_TEXT[status]} />}
      label={pageName(page, panel.hostName)}
      sub={[address, ...(used.length ? [`${used.join("、")} 用过`] : [])].join(
        " · ",
      )}
      trail={status === "sleeping" ? "休眠" : undefined}
      actions={
        <>
          <IconButton
            size="sm"
            label="在新标签打开"
            icon={<ExternalIcon size={12} />}
            onClick={() => panel.onNewTab(page)}
          />
          <IconButton
            size="sm"
            label="关闭页面"
            icon={<CloseIcon size={12} />}
            onClick={() => panel.onClosePage(page)}
          />
        </>
      }
      onClick={() => panel.onPick(page)}
    />
  );
}
