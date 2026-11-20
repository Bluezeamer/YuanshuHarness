import { Checkbox } from "../../../../ui";
import type { Catalog } from "../model/catalog";

// 可切换的模式清单：模式在对话里切换，这里只决定「能切到哪些」。
export function ModesEditor({
  cat,
  value,
  onChange,
}: {
  cat: Catalog;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  if (cat.modePresets.length === 0)
    return (
      <p className="t-aux">
        还没有模式预设。到「设置 · 提示词与能力 · 模式」里新建一个。
      </p>
    );
  const picked = new Set(value);
  const toggle = (id: string) =>
    onChange(picked.has(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="dlg-stack">
      <div className="dlg-checks">
        {cat.modePresets.map((p) => (
          <Checkbox
            key={p.id}
            checked={picked.has(p.id)}
            onChange={() => toggle(p.id)}
          >
            <span className="dlg-check-main">
              <span className="t-plain">{p.name}</span>
              {p.description && <span className="t-aux">{p.description}</span>}
            </span>
            <span className="t-mono dlg-check-meta">
              {p.capabilities === null
                ? "不限定工具"
                : `限定为 ${p.capabilities.length} 项`}
            </span>
          </Checkbox>
        ))}
      </div>
      <p className="t-aux">
        进入模式后追加它的提示词，并按它的设定限定、增加或减少工具；不改动已保存的历史。
      </p>
    </div>
  );
}
