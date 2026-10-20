import { field } from "../settings/shared";
import type { BlockInfo } from "./agentsApi";

const iconBtn =
  "border border-line px-2 py-0.5 text-xs font-semibold hover:bg-ink hover:text-bg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink";

// 有序的提示词块选择：已选块可上移、下移、移除；未选块从下拉里追加。
export function BlockPicker({
  blocks,
  value,
  onChange,
}: {
  blocks: BlockInfo[];
  value: string[];
  onChange(next: string[]): void;
}) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const rest = blocks.filter((b) => !value.includes(b.id));
  const move = (i: number, d: -1 | 1) => {
    const next = [...value];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x as string);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 ? (
        <p className="m-0 text-xs text-mute">未选择提示词块。</p>
      ) : (
        <ol
          aria-label="已选提示词块"
          className="m-0 flex list-none flex-col gap-1 p-0"
        >
          {value.map((id, i) => {
            const b = byId.get(id);
            return (
              <li
                key={id}
                className="flex items-center justify-between gap-2 border border-line px-2 py-1"
              >
                <span className="min-w-0 truncate">
                  <span className="font-mono text-xs text-mute">{i + 1}</span>{" "}
                  <span className="font-semibold">
                    {b ? b.name : "（块已删除）"}
                  </span>
                  {b && <span className="text-xs text-mute"> · {b.group}</span>}
                </span>
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    aria-label={`上移 ${b?.name ?? id}`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    className={iconBtn}
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    aria-label={`下移 ${b?.name ?? id}`}
                    disabled={i === value.length - 1}
                    onClick={() => move(i, 1)}
                    className={iconBtn}
                  >
                    下移
                  </button>
                  <button
                    type="button"
                    aria-label={`移除 ${b?.name ?? id}`}
                    onClick={() => onChange(value.filter((x) => x !== id))}
                    className={iconBtn}
                  >
                    移除
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <select
        aria-label="追加提示词块"
        value=""
        disabled={rest.length === 0}
        onChange={(e) => e.target.value && onChange([...value, e.target.value])}
        className={field}
      >
        <option value="">
          {rest.length ? "追加一个块…" : "没有可追加的块"}
        </option>
        {rest.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}（{b.group}）
          </option>
        ))}
      </select>
    </div>
  );
}
