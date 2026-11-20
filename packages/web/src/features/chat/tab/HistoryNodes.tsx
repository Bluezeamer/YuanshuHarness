// B20：历史节点浮层。双 Esc 触发（手势识别在 useDoubleEscape），两个视图：
// 「指令」列出当前分支的用户输入（点击直接回退），「树」显示完整会话树（分叉点可折叠，选中后「回到这里」）。
// 回退走 POST /navigate：成功后关闭浮层、toast 提示原分支保留，服务端返回的 editor（文字 + 附件）回填输入框草稿。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadToken } from "../../../api/http";
import {
  getSessionTree,
  navigateSession,
  type SessionTree,
  type TreeNode,
} from "../../../api/session-nav";
import { getUserMessages, type UserMessageEntry } from "../../../api/sessions";
import {
  Button,
  Chip,
  Empty,
  IconButton,
  InlineNotice,
  ListRow,
  Modal,
  Segmented,
  toast,
} from "../../../ui";
import { ChevronDownIcon, ChevronRightIcon } from "../../../ui/icons";
import type { ChatSession } from "../hooks";
import { refToAttachment } from "../input/attachments";
import { fmtNodeTime, previewLine } from "./conversationNav";
import { stripAttachLines } from "./format";
import { flattenTree, type TreeRow } from "./historyTree";

export interface HistoryNodesProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  session: ChatSession;
}

type View = "commands" | "tree";

interface Loaded {
  tree: SessionTree;
  messages: UserMessageEntry[];
}

const KIND_LABEL: Record<string, string> = {
  user: "你",
  assistant: "助手",
  toolResult: "工具",
  system: "系统",
  compaction: "压缩",
  branch_summary: "摘要",
};

// 节点类型徽标的色调：你 = 蓝，压缩 / 摘要 = 琥珀，其余不着色
const KIND_TONE: Record<string, { tone?: "accent" | "warn" }> = {
  user: { tone: "accent" },
  compaction: { tone: "warn" },
  branch_summary: { tone: "warn" },
};

const kindOf = (n: TreeNode): string =>
  n.type === "message" ? (n.role ?? "other") : n.type;

const commandPreview = (text: string): string =>
  previewLine(stripAttachLines(text)) || "（附件消息）";

export function HistoryNodes({
  open,
  onClose,
  sessionId,
  session,
}: HistoryNodesProps) {
  const [view, setView] = useState<View>("commands");
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const ticket = useRef(0);
  const moving = useRef(false);

  const load = useCallback(async () => {
    const mine = ++ticket.current;
    setLoading(true);
    setError(null);
    const token = loadToken();
    const [tree, messages] = await Promise.all([
      getSessionTree(sessionId, token),
      getUserMessages(sessionId, token),
    ]);
    if (mine !== ticket.current) return;
    setLoading(false);
    if (!tree.ok || !messages.ok) {
      setError("历史节点加载失败");
      return;
    }
    setData({ tree: tree.data, messages: messages.data });
    setSelected(null);
  }, [sessionId]);

  // 每次打开都重新取：会话可能又有了新消息 / 新分支，旧的树和指令列表不能直接用。
  useEffect(() => {
    if (!open) return;
    setData(null);
    setFolded(new Set());
    void load();
    return () => {
      ticket.current += 1;
    };
  }, [open, load]);

  const activePath = useMemo(
    () => new Set(data?.tree.activePath ?? []),
    [data],
  );
  const rows = useMemo(
    () =>
      data ? flattenTree(data.tree.nodes, data.tree.activePath, folded) : [],
    [data, folded],
  );
  // 指令列表里「当前」= activePath 上最深的那条用户消息；树里「当前」= leaf 节点。
  const currentUserId = useMemo(() => {
    const messages = data?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && activePath.has(m.entryId)) return m.entryId;
    }
    return null;
  }, [data, activePath]);
  const selectedRow = rows.find((r) => r.node.id === selected);
  const canGo =
    view === "tree" &&
    !busy &&
    selected !== null &&
    selected !== data?.tree.leafId;

  const go = async (entryId: string) => {
    // 连点两行时只认第一次：navigate 期间再点会拿到 409 / 重复导航。
    if (moving.current) return;
    moving.current = true;
    setBusy(true);
    const r = await navigateSession(sessionId, entryId, loadToken());
    moving.current = false;
    setBusy(false);
    if (!r.ok) {
      if (r.kind === "conflict")
        toast("运行中或压缩中，稍后再试", { tone: "warn" });
      else if (r.kind === "network")
        toast("网络错误，回退失败，请重试", { tone: "danger" });
      else toast("回退失败，请重试", { tone: "danger" });
      return;
    }
    // 服务端只对 user 消息返回原文与附件；回填草稿后浮层关闭，焦点交回输入框。
    const { editor } = r.data;
    if (editor) {
      session.actions.setDraft(editor.text);
      for (const a of editor.attachments)
        session.actions.addAttachment(refToAttachment(a));
    }
    onClose();
    toast("已回到该节点，原分支已保留", { tone: "ok" });
  };

  const toggleFold = (id: string) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const footer =
    view === "commands" ? (
      <p className="ch-hist-foot t-aux">
        点击或回车回退到该节点；原分支保留在树中
      </p>
    ) : (
      <>
        <p className="ch-hist-foot t-aux">
          {selectedRow ? selectedRow.node.preview : "选择一个节点，再回到这里"}
        </p>
        <Button
          variant="primary"
          size="sm"
          disabled={!canGo}
          onClick={() => selected !== null && void go(selected)}
        >
          回到这里
        </Button>
      </>
    );

  const commands = data?.messages ?? [];
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="历史节点"
      description="回到历史节点继续对话；原分支会保留，可以随时切回"
      size="lg"
      footer={footer}
    >
      <div className="ch-hist">
        <Segmented
          size="sm"
          aria-label="历史视图"
          options={[
            { value: "commands", label: "指令" },
            { value: "tree", label: "树" },
          ]}
          value={view}
          onChange={setView}
        />
        {loading && <p className="ch-hist-note t-aux">加载中…</p>}
        {error !== null && !loading && (
          <InlineNotice tone="danger" className="ch-hist-err">
            <span>{error}</span>
            <Button size="sm" onClick={() => void load()}>
              重试
            </Button>
          </InlineNotice>
        )}
        {data !== null && !loading && error === null && view === "commands" && (
          <Commands
            rows={commands}
            current={currentUserId}
            busy={busy}
            onGo={go}
          />
        )}
        {data !== null && !loading && error === null && view === "tree" && (
          <Tree
            rows={rows}
            leafId={data.tree.leafId}
            selected={selected}
            busy={busy}
            onSelect={setSelected}
            onFold={toggleFold}
            onGo={go}
          />
        )}
      </div>
    </Modal>
  );
}

function Commands({
  rows,
  current,
  busy,
  onGo,
}: {
  rows: readonly UserMessageEntry[];
  current: string | null;
  busy: boolean;
  onGo: (entryId: string) => Promise<void>;
}) {
  if (rows.length === 0)
    return (
      <Empty
        title="还没有历史指令"
        description="发送第一条消息后，这里会列出当前分支上可以回退的节点"
        compact
      />
    );
  return (
    <ol className="ch-hist-list" aria-label="历史指令">
      {rows.map((m, i) => {
        const active = m.entryId === current;
        return (
          <li key={m.entryId}>
            <ListRow
              size="compact"
              current={active}
              disabled={busy}
              title={stripAttachLines(m.text)}
              lead={<span className="ch-hist-no t-mono">#{i + 1}</span>}
              label={
                <span className="ch-hist-prev t-plain">
                  {commandPreview(m.text)}
                </span>
              }
              trail={
                <>
                  {m.timestamp !== null && (
                    <span className="ch-hist-time t-mono">
                      {fmtNodeTime(m.timestamp)}
                    </span>
                  )}
                  {active && (
                    <Chip tone="accent" className="ch-hist-mark">
                      当前
                    </Chip>
                  )}
                </>
              }
              onClick={() => void onGo(m.entryId)}
            />
          </li>
        );
      })}
    </ol>
  );
}

function Tree({
  rows,
  leafId,
  selected,
  busy,
  onSelect,
  onFold,
  onGo,
}: {
  rows: readonly TreeRow[];
  leafId: string | null;
  selected: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onFold: (id: string) => void;
  onGo: (entryId: string) => Promise<void>;
}) {
  if (rows.length === 0)
    return (
      <Empty
        title="还没有对话节点"
        description="会话里产生消息后，这里会显示完整的历史树"
        compact
      />
    );
  return (
    <ul className="ch-hist-tree" aria-label="会话树">
      {rows.map((row) => {
        const node = row.node;
        const current = node.id === leafId;
        const kind = kindOf(node);
        return (
          <li
            key={node.id}
            className="ch-hist-trow"
            data-active={row.active || undefined}
            data-current={current || undefined}
            data-selected={node.id === selected || undefined}
          >
            <span className="ch-hist-fold">
              {row.foldable && (
                <IconButton
                  size="sm"
                  label={row.folded ? "展开分支" : "折叠分支"}
                  aria-expanded={!row.folded}
                  icon={
                    row.folded ? (
                      <ChevronRightIcon size={12} />
                    ) : (
                      <ChevronDownIcon size={12} />
                    )
                  }
                  onClick={() => onFold(node.id)}
                />
              )}
            </span>
            <ListRow
              size="compact"
              className="ch-hist-node"
              current={current}
              selected={node.id === selected}
              disabled={busy}
              title={node.preview}
              lead={
                <>
                  <span className="ch-hist-prefix t-mono" aria-hidden="true">
                    {row.prefix}
                  </span>
                  <Chip
                    className="ch-hist-kind"
                    data-kind={kind}
                    {...KIND_TONE[kind]}
                  >
                    {KIND_LABEL[kind] ?? "节点"}
                  </Chip>
                </>
              }
              label={
                <span className="ch-hist-prev t-plain">{node.preview}</span>
              }
              trail={
                <>
                  {row.folded && (
                    <Chip className="ch-hist-mark">{row.hidden} 个节点</Chip>
                  )}
                  {current && (
                    <Chip tone="accent" className="ch-hist-mark">
                      当前
                    </Chip>
                  )}
                </>
              }
              onClick={() => onSelect(node.id)}
              onKeyDown={(e) => {
                // 行尾 / 折叠键自己的回车不归这里管
                if (
                  e.key !== "Enter" ||
                  !(e.target as HTMLElement).closest(".u-lrow-main")
                )
                  return;
                e.preventDefault();
                void onGo(node.id);
              }}
            />
          </li>
        );
      })}
    </ul>
  );
}
