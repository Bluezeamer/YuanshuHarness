import { useState } from "react";
import type { SkillView } from "../../../../api/skillLibrary";
import { ConfirmDialog } from "../../../../ui";
import { copyCount, type Hosts, hostLabel } from "./model";
import type { SkillsStore } from "./store";

/** 影响范围：库分发的副本会清理，原地登记（来自环境）的文件保留。 */
export function removeImpact(skills: readonly SkillView[]) {
  const kept = skills.filter((s) => s.origin?.kind === "observed");
  const cleaned = skills.filter((s) => s.origin?.kind !== "observed");
  return {
    copies: cleaned.reduce((n, s) => n + copyCount(s), 0),
    kept: kept.length,
  };
}

export function SkillRemoveDialog({
  skills,
  hosts,
  store,
  onDone,
  onClose,
}: {
  skills: readonly SkillView[];
  hosts: Hosts;
  store: SkillsStore;
  /** 完成后回调：成功卸载的名称，以及没清理干净的说明。 */
  onDone: (removed: string[], problems: string | null) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copies, kept } = removeImpact(skills);
  const single = skills.length === 1 ? skills[0] : undefined;

  const run = async () => {
    setBusy(true);
    const r = await store.batch(
      skills.map((s) => s.name),
      "uninstall",
    );
    setBusy(false);
    if (!r.ok) return setError(r.message);
    const removed = r.data.filter((x) => x.ok).map((x) => x.name);
    const problems = r.data.flatMap((x) => [
      ...(x.ok ? [] : [`${x.name}：${x.message ?? x.error}`]),
      ...(x.failed ?? []).map(
        (f) =>
          `${x.name} 在 ${hostLabel(hosts, f.hostId)} 清理失败：${f.message}`,
      ),
    ]);
    onDone(removed, problems.length ? problems.join("；") : null);
  };

  return (
    <ConfirmDialog
      open
      title={single ? `卸载 ${single.name}` : `卸载 ${skills.length} 个技能`}
      confirmLabel="卸载"
      busy={busy}
      error={error}
      onConfirm={() => void run()}
      onClose={onClose}
    >
      <p>
        {single
          ? single.origin?.kind === "observed"
            ? "来自环境的技能：库里的条目会移除，原地文件保留。"
            : `库里的条目会移除；会清理 ${copies} 个环境的副本。`
          : `库里的 ${skills.length} 个条目会移除${
              copies ? `；会清理 ${copies} 个环境的副本` : ""
            }${kept ? `；其中 ${kept} 个来自环境的技能，原地文件保留` : ""}。`}
      </p>
    </ConfirmDialog>
  );
}
