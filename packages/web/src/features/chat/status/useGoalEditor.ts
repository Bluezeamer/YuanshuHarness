import { useEffect, useState } from "react";
import type { Goal } from "../../../api";
import type { ChatActions } from "../hooks";
import {
  attachmentPaths,
  pendingReason,
  refToAttachment,
  useLocalAttachments,
} from "../input/attachments";
import { parseRoundsInput } from "../model/goal";

export type GoalActions = Pick<
  ChatActions,
  "editGoal" | "pauseGoal" | "resumeGoal" | "clearGoal"
>;

export type GoalEditor = ReturnType<typeof useGoalEditor>;

const maxText = (g: Goal): string =>
  g.maxRounds === null ? "" : String(g.maxRounds);

// 目标的就地编辑态跟着面板走，不跟着块：窄栏的卡片每次收起都会卸载，放在块里关了再开就丢了输入。
export function useGoalEditor(goal: Goal | null, actions: GoalActions) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [max, setMax] = useState("");
  const files = useLocalAttachments();
  const [why, setWhy] = useState<string | null>(null);
  // 目标被删或已完成（本端或别的端）时编辑态作废
  useEffect(() => {
    if (!goal || goal.state === "complete") setEditing(false);
  }, [goal]);
  const rounds = parseRoundsInput(max);
  return {
    editing,
    text,
    setText: (t: string) => {
      setText(t);
      setWhy(null);
    },
    files,
    /** 附件还没就绪时保存不了的原因 */
    why,
    max,
    setMax,
    /** 轮数上限输入不合法（只能空或 1–10000 的整数） */
    maxInvalid: rounds === undefined,
    // 按钮与双击走同一个入口；编辑中再次进入不覆盖已输入的内容
    open() {
      if (editing || !goal) return;
      setText(goal.text);
      setMax(maxText(goal));
      files.reset((goal.attachments ?? []).map(refToAttachment));
      setWhy(null);
      setEditing(true);
    },
    cancel: () => setEditing(false),
    save() {
      const t = text.trim();
      if (!goal || !t || rounds === undefined) return;
      const blocked = pendingReason(files.list);
      if (blocked) return setWhy(blocked);
      // 附件按路径列表比：有增删或换序才带上，整体替换
      const paths = files.list.map((a) => a.path);
      const before = (goal.attachments ?? []).map((a) => a.path);
      const patch: Parameters<GoalActions["editGoal"]>[0] = {
        ...(t === goal.text ? {} : { text: t }),
        ...(rounds === goal.maxRounds ? {} : { maxRounds: rounds }),
        ...(paths.join("\n") === before.join("\n")
          ? {}
          : { attachments: attachmentPaths(files.list) }),
      };
      if (Object.keys(patch).length === 0 || actions.editGoal(patch))
        setEditing(false);
    },
  };
}
