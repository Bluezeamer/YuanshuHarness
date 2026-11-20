import { useRef, useState } from "react";
import { Button, IconButton, Input } from "../../../../ui";
import { ChevronDownIcon, CloseIcon } from "../../../../ui/icons";
import { DirBrowser } from "../DirBrowser";
import {
  type Catalog,
  type Host,
  hostOf,
  suggestionsOf,
} from "../model/catalog";
import { isAbsolute, normDir } from "../model/path";
import { PickerPop } from "../PickerPop";

/** 一行目录：主机 + 绝对路径；已落库的行带 id，只读 */
export interface DirRowValue {
  /** 仅供 React 做 key */
  key: string;
  host: string;
  path: string;
  id?: string;
}

let seq = 0;
export const blankDir = (host: string, path = ""): DirRowValue => ({
  key: `dir-${Date.now().toString(36)}-${++seq}`,
  host,
  path,
});

function HostPicker({
  cat,
  host: hostId,
  locked,
  onHost,
}: {
  cat: Catalog;
  host: string;
  locked: boolean;
  onHost: (hostId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const host = hostOf(cat, hostId);
  return (
    <>
      <Button
        ref={anchor}
        className="ws-cr-host"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`选择主机，当前 ${host.name}`}
        disabled={locked}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ws-cr-host-role t-aux">{host.kind}</span>
        <span className="ws-cr-host-name t-plain">{host.name}</span>
        <ChevronDownIcon aria-hidden />
      </Button>
      <PickerPop
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        title="选择主机"
        count={`${cat.hosts.length} 台已连接`}
        width={360}
      >
        {cat.hosts.map((h: Host) => (
          <Button
            key={h.id}
            variant="ghost"
            role="option"
            aria-selected={h.id === hostId}
            className="ws-cr-prow"
            onClick={() => {
              setOpen(false);
              onHost(h.id);
            }}
          >
            <span className="ws-cr-kind t-mono">{h.kind}</span>
            <span className="ws-cr-pr-main">
              <span className="ws-cr-pr-name t-entry">{h.name}</span>
              <span className="ws-cr-pr-desc t-aux">{h.detail}</span>
            </span>
            <span className="ws-cr-pr-meta t-mono">
              {suggestionsOf(cat, h.id).length} 目录
            </span>
          </Button>
        ))}
      </PickerPop>
    </>
  );
}

// 主机 + 路径 + 目录浏览器。换主机时：路径为空或还是旧主机的建议路径才换成新主机的首条建议。
export function DirRow({
  row,
  cat,
  large,
  onChange,
  onRemove,
}: {
  row: DirRowValue;
  cat: Catalog;
  /** 主目录那一行：输入框用大号 */
  large?: boolean;
  onChange: (next: DirRowValue) => void;
  /** 不给就没有移除键（主目录） */
  onRemove?: () => void;
}) {
  const [browse, setBrowse] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const locked = row.id !== undefined;
  const bad = !locked && row.path !== "" && !isAbsolute(row.path);
  const host = hostOf(cat, row.host);

  const changeHost = (hostId: string) => {
    if (hostId === row.host) return;
    const old = suggestionsOf(cat, row.host);
    const follow = !row.path.trim() || old.includes(normDir(row.path));
    onChange({
      ...row,
      host: hostId,
      ...(follow ? { path: suggestionsOf(cat, hostId)[0] ?? "" } : {}),
    });
  };

  return (
    <div
      className="dlg-dir"
      data-large={large || undefined}
      data-removable={onRemove ? "" : undefined}
    >
      <HostPicker
        cat={cat}
        host={row.host}
        locked={locked}
        onHost={changeHost}
      />
      <div ref={box} className="ws-cr-pathbox">
        <Input
          mono
          large={large}
          aria-label="目录路径"
          aria-invalid={bad || undefined}
          placeholder={suggestionsOf(cat, row.host)[0] ?? "/path/to/project"}
          disabled={locked}
          value={row.path}
          onClick={() => setBrowse(true)}
          onChange={(e) => onChange({ ...row, path: e.target.value })}
        />
        <IconButton
          label="选择目录"
          icon={<ChevronDownIcon size={12} aria-hidden />}
          className="ws-cr-pathdrop"
          aria-haspopup="dialog"
          aria-expanded={browse}
          disabled={locked}
          onClick={() => setBrowse((o) => !o)}
        />
        <DirBrowser
          open={browse && !locked}
          onClose={() => setBrowse(false)}
          anchorRef={box}
          host={host}
          start={cat.directoryStart}
          value={row.path}
          onChoose={(p) => {
            onChange({ ...row, path: normDir(p) });
            setBrowse(false);
          }}
        />
      </div>
      {onRemove && (
        <IconButton
          label="移除这个目录"
          icon={<CloseIcon aria-hidden />}
          onClick={onRemove}
        />
      )}
    </div>
  );
}
