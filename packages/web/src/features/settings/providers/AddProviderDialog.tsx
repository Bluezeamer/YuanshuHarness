import { useState } from "react";
import type { ProviderView } from "../../../api/providers";
import { ListRow, Modal, SearchBox } from "../../../ui";
import { PlusIcon } from "../../../ui/icons";
import { apiLabel, monogram } from "./model";

// 添加供应商：自定义端点固定排第一，下面是内置的，搜索只过滤内置；已经在左侧的不能再选。
export function AddProviderDialog({
  list,
  added,
  onPickBuiltin,
  onPickCustom,
  onClose,
}: {
  list: readonly ProviderView[];
  added: ReadonlySet<string>;
  onPickBuiltin: (id: string) => void;
  onPickCustom: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const builtin = list
    .filter((p) => !p.custom)
    .filter(
      (p) =>
        !needle ||
        p.name.toLowerCase().includes(needle) ||
        p.id.toLowerCase().includes(needle),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Modal open onClose={onClose} title="添加供应商" size="sm">
      <div className="pv-add">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="搜索内置供应商"
          aria-label="搜索内置供应商"
        />
        <ListRow
          lead={
            <span className="pv-tile t-group" data-size="sm">
              <PlusIcon size={14} />
            </span>
          }
          label="自定义端点"
          sub="本地部署或中转服务：填地址和模型"
          onClick={onPickCustom}
        />
        <div className="t-group pv-add-h">内置</div>
        <ul className="pv-add-list">
          {builtin.map((p) => (
            <li key={p.id}>
              <ListRow
                lead={
                  <span className="pv-tile t-group" data-size="sm">
                    {monogram(p.name)}
                  </span>
                }
                label={p.name}
                sub={`${p.api ? apiLabel(p.api) : p.id}${p.methods.includes("oauth") ? " · 支持订阅登录" : ""}`}
                trail={added.has(p.id) ? "已添加" : undefined}
                onClick={
                  added.has(p.id) ? undefined : () => onPickBuiltin(p.id)
                }
                aria-disabled={added.has(p.id) || undefined}
              />
            </li>
          ))}
          {builtin.length === 0 && (
            <li className="t-aux pv-add-none">没有匹配的内置供应商</li>
          )}
        </ul>
      </div>
    </Modal>
  );
}
