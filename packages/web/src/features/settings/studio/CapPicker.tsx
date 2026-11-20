import { useState } from "react";
import { Button, ListRow, SearchBox } from "../../../ui";
import { CheckIcon } from "../../../ui/icons";
import type { CapGroup } from "./useCapCatalog";

// 能力清单：按组勾选，每组有全选与清空，可以搜。选中的是能力 id 列表。
export function CapPicker({
  groups,
  value,
  onChange,
  disabled,
}: {
  groups: CapGroup[];
  value: string[];
  onChange: (next: string[]) => void;
  /** 灰掉整个清单（例如「不限制」时） */
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const toggle = (id: string) =>
    onChange(
      value.includes(id) ? value.filter((x) => x !== id) : [...value, id],
    );
  return (
    <div>
      <SearchBox
        className="sd-search"
        value={q}
        onChange={setQ}
        placeholder="搜能力"
        aria-label="搜索能力"
      />
      <div className="sd-caps-body" data-off={disabled || undefined}>
        {groups.map((g) => {
          const items = g.items.filter(
            (c) => q === "" || `${c.name}${c.desc}`.includes(q),
          );
          if (items.length === 0) return null;
          const n = items.filter((c) => value.includes(c.id)).length;
          return (
            <section key={g.title} className="sd-caps-grp">
              <div className="sd-caps-h">
                <span className="t-group">{g.title}</span>
                <span className="t-aux">
                  {n} / {items.length}
                </span>
                <span className="sd-sp" />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    onChange([
                      ...value.filter((x) => !items.some((c) => c.id === x)),
                      ...items.map((c) => c.id),
                    ])
                  }
                >
                  全选
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    onChange(
                      value.filter((x) => !items.some((c) => c.id === x)),
                    )
                  }
                >
                  清空
                </Button>
              </div>
              {items.map((c) => {
                const checked = value.includes(c.id);
                return (
                  <ListRow
                    key={c.id}
                    size="compact"
                    lead={
                      <span className="sd-ck" data-on={checked || undefined}>
                        {checked && <CheckIcon />}
                      </span>
                    }
                    label={
                      <>
                        <span className="t-mono">{c.name}</span>
                        <span className="sd-cap-d t-aux">{c.desc}</span>
                      </>
                    }
                    trail={c.trail}
                    onClick={() => toggle(c.id)}
                  />
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}
