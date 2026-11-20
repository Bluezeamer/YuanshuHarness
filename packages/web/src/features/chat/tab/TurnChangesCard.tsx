// 轮末「本轮改动」：折成一行摘要（文件数 + 增删行），点开是文件清单；点文件在窗格里开一个 diff 标签看逐行差异。

import type { StoredTurn } from "../../../api/turnChanges";
import { Chip, ListRow } from "../../../ui";
import { useLayoutStore } from "../../workspace/layoutContext";
import { chatPaneOf } from "./chatPane";
import { Delta, FlowGroup } from "./FlowGroup";

const STATUS: Record<string, string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
};

export function TurnChangesCard({
  sessionId,
  turn,
}: {
  sessionId: string;
  turn: StoredTurn;
}) {
  const store = useLayoutStore();
  if (turn.files.length === 0) return null;

  // 以承载对话的窗格为参照：优先复用同主机 preview 所在窗格，没有就新开一个窗格
  const openDiff = (path: string) => {
    const at = chatPaneOf(store, sessionId);
    if (!at) return;
    store.openDiff(at.pid, at.tabId, turn.turn, path, sessionId);
  };

  const add = turn.files.reduce((a, f) => a + f.added, 0);
  const del = turn.files.reduce((a, f) => a + f.removed, 0);
  return (
    <section aria-label={`第 ${turn.turn} 轮改动`}>
      <FlowGroup
        label={`本轮改动 ${turn.total} 个文件`}
        trail={<Delta add={add} del={del} />}
      >
        {turn.files.map((f) => (
          <ListRow
            key={f.path}
            size="compact"
            title={`打开 ${f.path} 的改动`}
            label={
              <span className="ch-line">
                <span className="t-aux">{STATUS[f.status] ?? f.status}</span>
                <span className="ch-arg t-code">{f.path}</span>
              </span>
            }
            trail={<Delta add={f.added} del={f.removed} />}
            onClick={() => openDiff(f.path)}
          />
        ))}
        {turn.total > turn.files.length && (
          <div className="ch-more">
            <Chip tone="warn">只记录前 {turn.files.length} 个</Chip>
          </div>
        )}
      </FlowGroup>
    </section>
  );
}
