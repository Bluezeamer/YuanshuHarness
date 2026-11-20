// 版本历史里点开一条：看「恢复成这一版会变成什么样」，再决定恢复。笔记按行对比；画布是 JSON，
// 只列回来 / 消失 / 挪了位置的节点和连线数。恢复在服务端是一次新的提交，历史不会被改写。
import { useEffect, useMemo, useState } from "react";
import {
  readVersion,
  restoreVersion,
  type VersionEntry,
} from "../../../../api/canvas";
import { loadToken } from "../../../../api/http";
import { Button, InlineNotice, Loading, Modal } from "../../../../ui";
import { timeText } from "../files/paths";
import { DiffLines } from "../preview/DiffLines";
import { diffLines, trimDiff } from "../preview/diffLines";
import {
  type BoardChanges,
  boardChanges,
  isUnchanged,
  sourceLabel,
  summaryOf,
} from "./versions";

type Loaded =
  | { phase: "loading" }
  | { phase: "error"; text: string }
  /** 那个版本里没有这个文件（那一条是删除） */
  | { phase: "missing" }
  | { phase: "ready"; older: string; current: string };

export interface VersionDialogProps {
  env: string;
  dir: string;
  /** 看的是哪个文件（相对 `.canvas/`） */
  file: string;
  kind: "board" | "note";
  entry: VersionEntry;
  /** 现在的版本（列表里最新的一条） */
  latest: VersionEntry;
  /** 有没有没保存的改动：恢复会丢掉它们，要写明 */
  dirty: boolean;
  onClose(): void;
  /** 恢复成功之后：调用方重读主区、刷新列表 */
  onRestored(): void;
}

export function VersionDialog({
  env,
  dir,
  file,
  kind,
  entry,
  latest,
  dirty,
  onClose,
  onRestored,
}: VersionDialogProps) {
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isCurrent = entry.sha === latest.sha;

  useEffect(() => {
    let alive = true;
    const token = loadToken();
    void (async () => {
      const older = await readVersion(token, env, dir, file, entry.sha);
      if (!alive) return;
      if (!older.ok)
        return setLoaded(
          older.kind === "not_found"
            ? { phase: "missing" }
            : { phase: "error", text: "读不出这个版本" },
        );
      const current = isCurrent
        ? older
        : await readVersion(token, env, dir, file, latest.sha);
      if (!alive) return;
      setLoaded(
        current.ok
          ? { phase: "ready", older: older.data, current: current.data }
          : { phase: "error", text: "读不出现在的版本" },
      );
    })();
    return () => {
      alive = false;
    };
  }, [env, dir, file, entry.sha, latest.sha, isCurrent]);

  const noteLines = useMemo(
    () =>
      loaded.phase === "ready" && kind === "note"
        ? trimDiff(diffLines(loaded.current, loaded.older))
        : [],
    [loaded, kind],
  );
  const changes = useMemo(
    () =>
      loaded.phase === "ready" && kind === "board"
        ? boardChanges(loaded.current, loaded.older)
        : null,
    [loaded, kind],
  );
  const same =
    loaded.phase === "ready" &&
    (isCurrent ||
      loaded.older === loaded.current ||
      (kind === "board" && changes !== null && isUnchanged(changes)));

  const restore = async () => {
    setBusy(true);
    setError(null);
    const r = await restoreVersion(loadToken(), env, dir, file, entry.sha);
    setBusy(false);
    if (!r.ok) return setError("恢复失败，请重试");
    onRestored();
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${timeText(entry.ts)} 的版本`}
      description={`${sourceLabel(entry)} · ${summaryOf(entry)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          {loaded.phase === "ready" && !same && (
            <Button
              variant="primary"
              loading={busy}
              onClick={() => void restore()}
            >
              恢复到这一版
            </Button>
          )}
        </>
      }
    >
      <div className="cv-verdlg">
        {dirty && loaded.phase === "ready" && !same && (
          <InlineNotice tone="warn">
            你有没保存的改动，恢复后会丢掉它们。
          </InlineNotice>
        )}
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
        {loaded.phase === "loading" && <Loading>正在读取这个版本</Loading>}
        {loaded.phase === "error" && (
          <InlineNotice tone="danger">{loaded.text}</InlineNotice>
        )}
        {loaded.phase === "missing" && (
          <InlineNotice tone="info">
            这一版里没有这个文件（那次改动是把它删除了），没有可以恢复的内容。
          </InlineNotice>
        )}
        {loaded.phase === "ready" && same && (
          <InlineNotice tone="info">
            {isCurrent
              ? "这就是现在的版本。"
              : "这一版和现在的内容一样，不用恢复。"}
          </InlineNotice>
        )}
        {loaded.phase === "ready" && !same && kind === "note" && (
          <>
            <p className="cv-verdlg-hint t-aux">
              恢复成这一版之后：带「−」的行会去掉，带「+」的行会回来。
            </p>
            <DiffLines lines={noteLines} />
          </>
        )}
        {loaded.phase === "ready" && !same && kind === "board" && (
          <BoardSummary changes={changes} />
        )}
      </div>
    </Modal>
  );
}

function BoardSummary({ changes }: { changes: BoardChanges | null }) {
  if (changes === null)
    return (
      <InlineNotice tone="warn">
        这一版的画布文件读不出结构，不能列出差别；仍然可以恢复。
      </InlineNotice>
    );
  return (
    <div className="cv-verdlg-board">
      <p className="cv-verdlg-hint t-aux">
        只恢复画布本身（卡片的摆放与连线）；卡片里的文字各有自己的版本，不会跟着变。
      </p>
      <NodeList title="恢复后会回来的" names={changes.back} />
      <NodeList title="恢复后会消失的" names={changes.gone} />
      {changes.moved > 0 && (
        <p className="cv-verdlg-line t-plain">
          {changes.moved} 张卡片的位置或大小会变回去
        </p>
      )}
      {(changes.edgesBack > 0 || changes.edgesGone > 0) && (
        <p className="cv-verdlg-line t-plain">
          连线：回来 {changes.edgesBack} 条，去掉 {changes.edgesGone} 条
        </p>
      )}
    </div>
  );
}

function NodeList({ title, names }: { title: string; names: string[] }) {
  if (names.length === 0) return null;
  const SHOWN = 12;
  return (
    <div className="cv-verdlg-group">
      <div className="cv-verdlg-title t-entry">
        {title}（{names.length}）
      </div>
      <ul className="cv-verdlg-names t-plain">
        {names.slice(0, SHOWN).map((n, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 名字可能重复，列表只读
          <li key={i}>{n}</li>
        ))}
        {names.length > SHOWN && <li>…还有 {names.length - SHOWN} 个</li>}
      </ul>
    </div>
  );
}
