import { useEffect, useState } from "react";
import type { McpVersions, McpView } from "../../../../api/mcpLibrary";
import { VersionPicker } from "../common/VersionPicker";
import { VERSION_RE } from "./model";
import type { McpStore } from "./store";

// 选版本：选旧版本等于回退并锁定（版本列标「低于解析」）；候选之外允许手填，按 x.y.z 校验。
export function McpVersionsDialog({
  server: m,
  store,
  onClose,
}: {
  server: McpView;
  store: McpStore;
  onClose: () => void;
}) {
  const [data, setData] = useState<McpVersions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void store.versions(m.name).then((r) => {
      if (!live) return;
      if (r.ok) setData(r.data);
      else setLoadError(r.message);
    });
    return () => {
      live = false;
    };
  }, [store, m.name]);

  const apply = async (version: string) => {
    setBusy(true);
    setApplyError(null);
    const r = await store.tryPin(m.name, version);
    setBusy(false);
    if (r.ok) onClose();
    else setApplyError(r.message);
  };

  return (
    <VersionPicker
      open
      title={`选择版本 · ${m.name}`}
      description="选中后在 Server 本机试装；成功才写回，选旧版本即回退并锁定。"
      loading={data === null && loadError === null}
      loadError={loadError}
      versions={data?.versions ?? []}
      pinned={m.version}
      custom={{
        label: "手填版本",
        validate: (v) => (VERSION_RE.test(v) ? null : "版本形如 x.y.z"),
      }}
      applyLabel="固定到此版本"
      busy={busy}
      applyError={applyError}
      onApply={(v) => void apply(v)}
      onClose={onClose}
    />
  );
}
