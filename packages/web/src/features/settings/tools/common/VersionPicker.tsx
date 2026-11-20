import { useState } from "react";
import { Button, Chip, InlineNotice, Input, Modal } from "../../../../ui";

export interface VersionOption {
  version: string;
  current: boolean;
  latest: boolean;
}

export interface VersionPickerProps {
  open: boolean;
  title: string;
  description?: string;
  loading?: boolean;
  /** 候选加载失败的原因。 */
  loadError?: string | null;
  versions: readonly VersionOption[];
  /** 当前锁定 / 固定的版本，候选里标出来。 */
  pinned?: string | null;
  /** 候选之外允许手填（MCP）；返回错误文案表示不合法。 */
  custom?: { label: string; validate: (v: string) => string | null };
  /** 底部唯一主按钮的文案。 */
  applyLabel: string;
  busy?: boolean;
  /** 落定失败的原因。 */
  applyError?: string | null;
  onApply: (version: string) => void;
  onClose: () => void;
}

// 版本候选列表：当前版标「当前」、最新版标「最新」，选中后由底部唯一主按钮落定。技能与 MCP 共用。
export function VersionPicker({
  open,
  title,
  description,
  loading,
  loadError,
  versions,
  pinned,
  custom,
  applyLabel,
  busy,
  applyError,
  onApply,
  onClose,
}: VersionPickerProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);

  const apply = () => {
    if (typed.trim() !== "") {
      const bad = custom?.validate(typed.trim()) ?? null;
      setTypedError(bad);
      if (!bad) onApply(typed.trim());
      return;
    }
    if (picked) onApply(picked);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={picked === null && typed.trim() === ""}
            onClick={apply}
          >
            {applyLabel}
          </Button>
        </>
      }
    >
      {loading && (
        <p className="st-tl-dim t-aux" role="status">
          正在读取候选版本…
        </p>
      )}
      {loadError && <InlineNotice tone="danger">{loadError}</InlineNotice>}
      <ul className="st-tl-vers" aria-label="候选版本">
        {versions.map((v) => (
          <li key={v.version}>
            {/* biome-ignore lint/a11y/useSemanticElements: 整行可点的候选项，自绘选中态；原生 radio 无法承载「当前 / 最新」标签的排版 */}
            <Button
              size="sm"
              role="radio"
              aria-checked={picked === v.version}
              data-v={v.version}
              className="st-tl-ver"
              onClick={() => {
                setPicked(v.version);
                setTyped("");
                setTypedError(null);
              }}
            >
              <span className="st-tl-ver-n t-mono">{v.version}</span>
              {v.current && <Chip>当前</Chip>}
              {v.latest && <Chip>最新</Chip>}
              {pinned === v.version && <Chip>已锁定</Chip>}
            </Button>
          </li>
        ))}
      </ul>
      {custom && (
        <div className="st-tl-vcustom">
          <label className="st-tl-dim t-aux" htmlFor="st-tl-ver-custom">
            {custom.label}
          </label>
          <Input
            id="st-tl-ver-custom"
            mono
            value={typed}
            placeholder="x.y.z"
            aria-invalid={typedError ? true : undefined}
            onChange={(e) => {
              setTyped(e.target.value);
              setTypedError(null);
              if (e.target.value) setPicked(null);
            }}
          />
          {typedError && (
            <InlineNotice tone="danger">{typedError}</InlineNotice>
          )}
        </div>
      )}
      {applyError && <InlineNotice tone="danger">{applyError}</InlineNotice>}
    </Modal>
  );
}
