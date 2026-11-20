import { useState } from "react";
import type { VariableView } from "../../../../api/variables";
import { Checkbox, IconButton, SearchBox } from "../../../../ui";
import { ChevronRightIcon } from "../../../../ui/icons";

const POLICY: Record<VariableView["policy"], string> = {
  allow: "自动放行",
  ask: "每次批准",
  deny: "禁止",
};

const matches = (v: VariableView, q: string) =>
  !q || v.name.toLowerCase().includes(q) || v.desc.toLowerCase().includes(q);

/**
 * 这个工作区启用哪些隐私变量：按变量组勾选，组行是三态，展开后可以单独取消。
 * 存的是具体勾了哪几个变量；组只是批量勾选的快捷方式，之后新加进组的变量不会自动被勾上。
 */
export function VariablesEditor({
  variables,
  value,
  onChange,
}: {
  variables: readonly VariableView[];
  /** 已启用的变量 id。 */
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const on = new Set(value);
  // 一开始只展开「勾了一部分」的组，让例外一眼看到；之后展开 / 收起都由用户点箭头决定，
  // 不会因为勾选变化而在手底下合上
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => {
    const out = new Set<string>();
    for (const g of new Set(variables.map((v) => v.group ?? ""))) {
      const ids = variables.filter((v) => (v.group ?? "") === g);
      const n = ids.filter((v) => on.has(v.id)).length;
      if (n > 0 && n < ids.length) out.add(g);
    }
    return out;
  });
  const needle = q.trim().toLowerCase();

  if (variables.length === 0)
    return (
      <p className="t-aux">
        还没有隐私变量。先在「设置 · 隐私变量」里添加，再回来启用。
      </p>
    );

  const names = [
    ...new Set(variables.map((v) => v.group).filter((g): g is string => !!g)),
  ].sort((a, b) => a.localeCompare(b));
  const sections = [
    ...names.map((g) => ({ key: g, name: g, isGroup: true })),
    { key: "", name: "未分组", isGroup: false },
  ]
    .map((s) => ({
      ...s,
      all: variables.filter((v) => (v.group ?? "") === s.key),
      items: variables.filter(
        (v) => (v.group ?? "") === s.key && matches(v, needle),
      ),
    }))
    .filter((s) => s.items.length > 0);

  const set = (ids: readonly string[], next: boolean) => {
    const s = new Set(value);
    for (const id of ids) {
      if (next) s.add(id);
      else s.delete(id);
    }
    onChange([...s].sort());
  };

  return (
    <div className="dlg-vars">
      <div className="dlg-vars-bar">
        <SearchBox
          aria-label="筛选变量"
          placeholder="筛选名称或描述"
          value={q}
          onChange={setQ}
        />
        <span className="t-mono">
          已启用 {value.length} / {variables.length}
        </span>
      </div>
      <div className="dlg-vars-list">
        {sections.map((s) => {
          const n = s.all.filter((v) => on.has(v.id)).length;
          const open = !!needle || opened.has(s.key);
          const state = n === 0 ? false : n === s.all.length ? true : "mixed";
          return (
            <div key={s.key} className="dlg-vars-sec">
              <div className="dlg-vars-grp">
                <IconButton
                  size="sm"
                  label={open ? `收起 ${s.name}` : `展开 ${s.name}`}
                  aria-expanded={open}
                  icon={
                    <ChevronRightIcon
                      className="dlg-vars-chev"
                      data-open={open || undefined}
                    />
                  }
                  onClick={() =>
                    setOpened((o) => {
                      const next = new Set(o);
                      if (!next.delete(s.key)) next.add(s.key);
                      return next;
                    })
                  }
                />
                {s.isGroup ? (
                  <Checkbox
                    className="dlg-vars-gcheck"
                    checked={state}
                    onChange={(next) =>
                      set(
                        s.all.map((v) => v.id),
                        next,
                      )
                    }
                  >
                    <span className="t-entry">{s.name}</span>
                  </Checkbox>
                ) : (
                  <span className="dlg-vars-gcheck t-group">{s.name}</span>
                )}
                <span className="t-mono dlg-vars-n">
                  {n} / {s.all.length}
                </span>
              </div>
              {open &&
                s.items.map((v) => (
                  <Checkbox
                    key={v.id}
                    className="dlg-vars-row"
                    checked={on.has(v.id)}
                    onChange={(next) => set([v.id], next)}
                  >
                    <span className="dlg-vars-name t-entry">{v.name}</span>
                    <span className="dlg-vars-desc t-aux">{v.desc}</span>
                    <span className="t-aux">
                      {v.expired ? "已过期" : POLICY[v.policy]}
                    </span>
                  </Checkbox>
                ))}
            </div>
          );
        })}
        {sections.length === 0 && (
          <p className="dlg-vars-none t-aux">没有匹配的变量</p>
        )}
      </div>
      <p className="t-aux">
        默认都不启用。勾上后，这个工作区里所有会话下一轮起就能引用；勾组是一次性勾上组里现有的变量，之后新加进组的要再勾。
      </p>
    </div>
  );
}
