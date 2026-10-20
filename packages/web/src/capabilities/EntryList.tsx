import type { McpEntryInfo, SecretInfo } from "../api";
import { field } from "../settings/shared";

// 表单里的一行：明文值与密码库引用二选一。
export interface EntryRow {
  // 仅作 React key，不进提交内容。
  uid: number;
  key: string;
  mode: "value" | "secret";
  value: string;
  secretId: string;
  prefix: string;
}

let seq = 0;

export const emptyRow = (): EntryRow => ({
  uid: ++seq,
  key: "",
  mode: "value",
  value: "",
  secretId: "",
  prefix: "",
});

export const toRows = (list: McpEntryInfo[]): EntryRow[] =>
  list.map((e) => ({
    uid: ++seq,
    key: e.key,
    mode: e.secretId === undefined ? "value" : "secret",
    value: e.value ?? "",
    secretId: e.secretId ?? "",
    prefix: e.prefix ?? "",
  }));

export const fromRows = (rows: EntryRow[]): McpEntryInfo[] =>
  rows
    .filter((r) => r.key.trim() !== "")
    .map((r) =>
      r.mode === "secret"
        ? {
            key: r.key.trim(),
            secretId: r.secretId,
            ...(r.prefix ? { prefix: r.prefix } : {}),
          }
        : { key: r.key.trim(), value: r.value },
    );

// 凭证走密码库：选条目而不是粘贴明文，库里只存引用。
export function EntryList({
  label,
  rows,
  secrets,
  onChange,
}: {
  label: string;
  rows: EntryRow[];
  secrets: SecretInfo[];
  onChange(rows: EntryRow[]): void;
}) {
  const set = (i: number, patch: Partial<EntryRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1 p-0 text-xs font-semibold">{label}</legend>
      {rows.map((r, i) => (
        <div
          key={r.uid}
          className="grid gap-2 min-[700px]:grid-cols-[1fr_auto_2fr_auto]"
        >
          <input
            aria-label={`${label}名称 ${i + 1}`}
            placeholder="名称"
            value={r.key}
            onChange={(e) => set(i, { key: e.target.value })}
            className={field}
          />
          <select
            aria-label={`${label}取值方式 ${i + 1}`}
            value={r.mode}
            onChange={(e) =>
              set(i, { mode: e.target.value as EntryRow["mode"] })
            }
            className={field}
          >
            <option value="value">明文</option>
            <option value="secret">密码库</option>
          </select>
          {r.mode === "value" ? (
            <input
              aria-label={`${label}值 ${i + 1}`}
              placeholder="值"
              value={r.value}
              onChange={(e) => set(i, { value: e.target.value })}
              className={field}
            />
          ) : (
            <span className="grid grid-cols-[1fr_auto] gap-2">
              <select
                aria-label={`${label}密码库条目 ${i + 1}`}
                value={r.secretId}
                onChange={(e) => set(i, { secretId: e.target.value })}
                className={field}
              >
                <option value="">选择条目</option>
                {secrets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <input
                aria-label={`${label}前缀 ${i + 1}`}
                placeholder="前缀，如 Bearer "
                value={r.prefix}
                onChange={(e) => set(i, { prefix: e.target.value })}
                className={`${field} w-36`}
              />
            </span>
          )}
          <button
            type="button"
            aria-label={`移除${label} ${i + 1}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            className="border border-line px-2 text-xs font-semibold hover:bg-ink hover:text-bg"
          >
            移除
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          onClick={() => onChange([...rows, emptyRow()])}
          className="border border-line px-3 py-1 text-xs font-semibold hover:bg-ink hover:text-bg"
        >
          添加一项
        </button>
      </div>
    </fieldset>
  );
}
