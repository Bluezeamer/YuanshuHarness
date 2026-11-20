// 版本历史面板：看当前画布 / 笔记自己的提交列表，点开一条看差别并恢复；也能撤销 agent 的上一次修改。
// 数据都在这个目录的 `.canvas/` 自己的 git 里（服务端接口早就有）。
import { useCallback, useEffect, useState } from "react";
import {
  listVersions,
  undoAgent,
  type VersionEntry,
} from "../../../../api/canvas";
import { loadToken } from "../../../../api/http";
import {
  Button,
  ConfirmDialog,
  Empty,
  IconButton,
  InlineNotice,
  ListRow,
  Loading,
  toast,
} from "../../../../ui";
import { CloseIcon, RefreshIcon } from "../../../../ui/icons";
import { timeText } from "../files/paths";
import { VersionDialog } from "./VersionDialog";
import { sourceLabel, summaryOf } from "./versions";

const LIMIT = 100;

type Loaded =
  | { phase: "loading" }
  | { phase: "error" }
  | {
      phase: "ready";
      entries: VersionEntry[];
      /** 整个 `.canvas/` 最新的一条：是 agent 的才能撤销 */
      head: VersionEntry | null;
    };

export interface VersionsPanelProps {
  env: string;
  dir: string;
  /** 看谁的历史：相对 `.canvas/` 的路径（画布是 `名.canvas`，笔记是 `路径.md`） */
  file: string;
  kind: "board" | "note";
  /** 面板头上写的名字 */
  title: string;
  /** 这台主机上有没有 git（没有就没有历史） */
  gitMissing: boolean;
  /** 有没有没保存的改动：恢复与撤销会丢掉它们 */
  dirty: boolean;
  /** 恢复或撤销成功后：调用方重读主区 */
  onChanged(): void;
  onClose(): void;
}

export function VersionsPanel({
  env,
  dir,
  file,
  kind,
  title,
  gitMissing,
  dirty,
  onChanged,
  onClose,
}: VersionsPanelProps) {
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const [picked, setPicked] = useState<VersionEntry | null>(null);
  const [asking, setAsking] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (gitMissing)
      return setLoaded({ phase: "ready", entries: [], head: null });
    const token = loadToken();
    const [mine, head] = await Promise.all([
      listVersions(token, env, dir, file, LIMIT),
      listVersions(token, env, dir, undefined, 1),
    ]);
    setLoaded(
      mine.ok
        ? {
            phase: "ready",
            entries: mine.data,
            head: head.ok ? (head.data[0] ?? null) : null,
          }
        : { phase: "error" },
    );
  }, [env, dir, file, gitMissing]);

  // 换了文件重读；没保存的改动变成「没有」（刚保存完）也重读：保存会落一次新的提交
  // biome-ignore lint/correctness/useExhaustiveDependencies: dirty 只是「保存完了」的触发信号
  useEffect(() => {
    setPicked(null);
    void load();
  }, [load, dirty]);

  const changed = () => {
    setPicked(null);
    void load();
    onChanged();
  };

  const undo = async () => {
    setUndoing(true);
    setUndoError(null);
    const r = await undoAgent(loadToken(), env, dir);
    setUndoing(false);
    if (!r.ok) return setUndoError(r.message);
    setAsking(false);
    toast("已撤销 agent 的上一次修改", { tone: "ok" });
    changed();
  };

  const entries = loaded.phase === "ready" ? loaded.entries : [];
  const head = loaded.phase === "ready" ? loaded.head : null;
  const latest = entries[0];

  return (
    <aside className="cv-vers-panel" aria-label="历史">
      <div className="cv-vers-head">
        <span className="cv-vers-title t-group">历史</span>
        <span className="cv-gap" />
        <IconButton
          label="刷新"
          icon={<RefreshIcon />}
          onClick={() => void load()}
        />
        <IconButton label="关闭历史" icon={<CloseIcon />} onClick={onClose} />
      </div>
      <div className="cv-vers-sub t-aux" title={title}>
        {title}
      </div>
      {head?.source === "agent" && (
        <div className="cv-vers-undo">
          <Button
            size="sm"
            variant="ghost"
            title={summaryOf(head)}
            onClick={() => {
              setUndoError(null);
              setAsking(true);
            }}
          >
            撤销 agent 的上一次修改
          </Button>
        </div>
      )}
      <div className="cv-vers-list">
        {gitMissing && (
          <Empty
            compact
            title="没有历史"
            description="这台主机上没有 git，改动没有被记录。"
          />
        )}
        {!gitMissing && loaded.phase === "loading" && (
          <Loading compact>正在读取</Loading>
        )}
        {loaded.phase === "error" && (
          <InlineNotice tone="danger">
            读不出历史。
            <Button size="sm" variant="ghost" onClick={() => void load()}>
              重试
            </Button>
          </InlineNotice>
        )}
        {!gitMissing && loaded.phase === "ready" && entries.length === 0 && (
          <Empty
            compact
            title="还没有历史"
            description="保存或改动之后，每一次都会记在这里，可以随时恢复。"
          />
        )}
        {entries.map((e, i) => (
          <ListRow
            key={e.sha}
            label={summaryOf(e)}
            title={summaryOf(e)}
            sub={`${timeText(e.ts)} · ${sourceLabel(e)}`}
            {...(i === 0 ? { trail: "当前" } : {})}
            current={picked?.sha === e.sha}
            onClick={() => setPicked(e)}
          />
        ))}
      </div>

      {picked && latest && (
        <VersionDialog
          env={env}
          dir={dir}
          file={file}
          kind={kind}
          entry={picked}
          latest={latest}
          dirty={dirty}
          onClose={() => setPicked(null)}
          onRestored={() => {
            toast(`已恢复到 ${timeText(picked.ts)} 的版本`, { tone: "ok" });
            changed();
          }}
        />
      )}
      <ConfirmDialog
        open={asking}
        title="撤销 agent 的上一次修改？"
        confirmLabel="撤销"
        tone="primary"
        busy={undoing}
        error={undoError}
        onConfirm={() => void undo()}
        onClose={() => setAsking(false)}
      >
        {head ? `${summaryOf(head)}。` : ""}
        这会作为新的一条记进历史，原来的版本都还在
        {dirty ? "；你有没保存的改动，撤销后会丢掉它们" : ""}。
      </ConfirmDialog>
    </aside>
  );
}
