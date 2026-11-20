import { useEffect, useState } from "react";
import type { SkillVersions, SkillView } from "../../../../api/skillLibrary";
import { VersionPicker } from "../common/VersionPicker";
import type { SkillsStore } from "./store";

// 锁到某一版：候选来自来源，选中后「锁到此版本」落定；落定后补齐只补到这一版。
export function SkillVersionsDialog({
  skill,
  store,
  onClose,
}: {
  skill: SkillView;
  store: SkillsStore;
  onClose: () => void;
}) {
  const [data, setData] = useState<SkillVersions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void store.versions(skill.name).then((r) => {
      if (!live) return;
      if (r.ok) setData(r.data);
      else setLoadError(r.message);
    });
    return () => {
      live = false;
    };
  }, [store, skill.name]);

  const apply = async (version: string) => {
    setBusy(true);
    const r = await store.lock(skill.name, version);
    setBusy(false);
    if (r.ok) onClose();
    else setApplyError(r.message);
  };

  return (
    <VersionPicker
      open
      title={`选择版本 · ${skill.name}`}
      description="锁定后不再催更新，补齐也只补到这一版；解除锁定即回到跟最新。"
      loading={data === null && loadError === null}
      loadError={loadError}
      versions={data?.versions ?? []}
      pinned={skill.lockedVersion}
      applyLabel="锁到此版本"
      busy={busy}
      applyError={applyError}
      onApply={(v) => void apply(v)}
      onClose={onClose}
    />
  );
}
