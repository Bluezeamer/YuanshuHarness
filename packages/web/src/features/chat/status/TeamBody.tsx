import { useState } from "react";
import type { ExecutionBody } from "../../../api/flows";
import type { TeamView } from "../../../api/team";
import { ListRow, PeekCard } from "../../../ui";
import { ChevronDownIcon, ChevronRightIcon } from "../../../ui/icons";
import { Delta } from "../tab/FlowGroup";
import { STATUS_LABEL, StatusMark } from "./SubTree";
import { statusOf } from "./subTree";

const FILE_STATUS = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
} as const;

const brief = (s: string, n = 80) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

// 团队：名册（成员一直全显，名册就是团队的结构，不走折叠；点一行开成员的会话）
// + 公告板一行（悬停最近 3 条，点开用预览标签看文件）
// + 团队改动一行（点开列出文件，点文件用对比标签看逐行差异）。没有公告、没有改动的行不画。
export function TeamBody({
  members,
  team,
  onOpen,
  onOpenBoard,
  onOpenDiff,
}: {
  members: readonly ExecutionBody[];
  team: TeamView | null;
  onOpen(id: string): void;
  onOpenBoard(file: string): void;
  onOpenDiff(path: string): void;
}) {
  const [filesOpen, setFilesOpen] = useState(false);
  const changes = team?.changes && team.changes.total > 0 ? team.changes : null;
  return (
    <>
      <ul className="ch-tree">
        {members.map((m) => {
          const status = statusOf(m);
          const name = m.member ?? m.name;
          return (
            <li key={m.id} data-member={m.id} data-status={status}>
              <ListRow
                size="compact"
                lead={<StatusMark status={status} />}
                label={name}
                trail={<span className="t-aux">{m.role}</span>}
                onClick={() => onOpen(m.id)}
                peek={
                  <PeekCard
                    title={name}
                    text={m.task}
                    facts={[
                      ["状态", STATUS_LABEL[status]],
                      status === "error"
                        ? ["失败原因", m.result ?? "未知"]
                        : [
                            "最新交付",
                            status === "ok" ? (m.result ?? "无摘要") : "还没有",
                          ],
                    ]}
                  />
                }
              />
            </li>
          );
        })}
      </ul>
      {team && team.board.count > 0 && (
        <ListRow
          size="compact"
          label="公告板"
          data-team="board"
          trail={<span className="t-mono">{team.board.count} 条</span>}
          onClick={() => onOpenBoard(team.board.file)}
          peek={
            <PeekCard
              title="公告板（最近 3 条）"
              facts={team.board.recent.map(
                (e) => [`#${e.no} ${e.from}`, brief(e.text)] as const,
              )}
            />
          }
        />
      )}
      {changes && (
        <>
          <ListRow
            size="compact"
            lead={filesOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
            label="团队改动"
            data-team="changes"
            trail={<span className="t-mono">{changes.total} 个文件</span>}
            onClick={() => setFilesOpen((o) => !o)}
          />
          {filesOpen && (
            <ul className="ch-kids" data-team="files">
              {changes.files.map((f) => (
                <li className="ch-kid" key={f.path} data-file={f.path}>
                  <ListRow
                    size="compact"
                    label={f.path.split("/").pop() ?? f.path}
                    trail={<Delta add={f.added} del={f.removed} />}
                    onClick={() => onOpenDiff(f.path)}
                    peek={
                      <PeekCard
                        title={f.path}
                        facts={[["状态", FILE_STATUS[f.status]]]}
                      />
                    }
                  />
                </li>
              ))}
              {changes.total > changes.files.length && (
                <li className="ch-kid">
                  <span className="t-aux ch-dim">
                    只记录前 {changes.files.length} 个
                  </span>
                </li>
              )}
            </ul>
          )}
        </>
      )}
    </>
  );
}
