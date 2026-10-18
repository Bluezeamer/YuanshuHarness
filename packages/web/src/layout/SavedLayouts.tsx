import { useState } from "react";
import {
  createSavedLayout,
  deleteSavedLayout,
  listSavedLayouts,
  loadToken,
  type SavedLayout,
} from "../api";
import type { PaneEntry, TreeNode } from "./types";

export interface SavedWindow {
  name: string;
  tree: TreeNode | null;
  panes: Record<string, PaneEntry>;
}

const btn =
  "border border-line px-2 py-0.5 text-xs font-semibold hover:bg-ink hover:text-bg";

const asSaved = (d: unknown, currentVersion: number): SavedWindow | null => {
  const s = d as Partial<SavedWindow & { version?: number }> | null;
  if (
    !s ||
    typeof s.name !== "string" ||
    typeof s.panes !== "object" ||
    !s.panes
  )
    return null;
  if (typeof s.version === "number" && s.version > currentVersion) return null;
  return { name: s.name, tree: s.tree ?? null, panes: s.panes };
};

// R22：已存布局是单个 window 的名字、树与其引用的 pane 条目。
export function SavedLayouts({
  snapshot,
  onApply,
  onUnauthorized,
  currentVersion,
}: {
  snapshot: () => SavedWindow | null;
  onApply: (s: SavedWindow) => void;
  onUnauthorized: () => void;
  currentVersion: number;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SavedLayout[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fail = (kind: string) => {
    if (kind === "unauthorized") onUnauthorized();
    else setError("操作失败，请重试");
  };

  const refresh = async () => {
    const r = await listSavedLayouts(loadToken());
    if (r.ok) {
      setItems(r.data);
      setError(null);
    } else fail(r.kind);
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void refresh();
  };

  const save = async () => {
    const snap = snapshot();
    if (!snap) return;
    const name = window.prompt("已存布局名称", snap.name)?.trim();
    if (!name) return;
    const r = await createSavedLayout(loadToken(), {
      version: 1,
      ...snap,
      name,
    });
    if (r.ok) await refresh();
    else fail(r.kind);
  };

  const remove = async (id: string) => {
    const r = await deleteSavedLayout(loadToken(), id);
    if (r.ok || r.kind === "not_found") await refresh();
    else fail(r.kind);
  };

  return (
    <span className="relative flex items-center gap-1">
      <button
        type="button"
        className={btn}
        aria-expanded={open}
        onClick={toggle}
      >
        已存布局
      </button>
      {open && (
        <fieldset
          aria-label="已存布局"
          className="absolute left-0 top-full z-20 m-0 w-64 min-w-0 border border-line bg-panel p-2"
        >
          <button type="button" className={btn} onClick={() => void save()}>
            存当前 window
          </button>
          {error && (
            <p role="alert" className="py-1 text-xs text-acc">
              {error}
            </p>
          )}
          {items.length === 0 ? (
            <p className="py-2 text-xs text-mute">还没有已存布局</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {items.map((it) => {
                const s = asSaved(it.document, currentVersion);
                return (
                  <li
                    key={it.id}
                    className="flex items-center justify-between gap-2 border-b border-line2 py-1 text-sm"
                  >
                    <span className="truncate">
                      {s?.name ?? "无法识别（版本过新）"}
                    </span>
                    <span className="flex gap-1">
                      {s && (
                        <button
                          type="button"
                          className={btn}
                          aria-label={`套用 ${s.name}`}
                          onClick={() => {
                            onApply(s);
                            setOpen(false);
                          }}
                        >
                          套用
                        </button>
                      )}
                      <button
                        type="button"
                        className={btn}
                        aria-label={`删除已存布局 ${s?.name ?? it.id}`}
                        onClick={() => void remove(it.id)}
                      >
                        删除
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      )}
    </span>
  );
}
