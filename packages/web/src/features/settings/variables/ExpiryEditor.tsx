import { useState } from "react";
import type { VarExpiry } from "../../../api/variables";
import { Input, Segmented } from "../../../ui";
import { DAYS_MAX, toLocalInput } from "./model";

const DAY = 86_400_000;

type Mode = VarExpiry["kind"];

const MODES = [
  { value: "days", label: "过期天数" },
  { value: "at", label: "到期时间" },
  { value: "never", label: "永久" },
] as const;

export interface ExpiryEditorProps {
  value: VarExpiry;
  onChange: (next: VarExpiry) => void;
  now: number;
}

const parseDays = (s: string): number | null => {
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= DAYS_MAX ? n : null;
};

// 有效期三选一：天数（从最近一次写入值起滚动）/ 到期时间 / 永久。每一次合法的修改都交给调用方（草稿）。
export function ExpiryEditor({ value, onChange, now }: ExpiryEditorProps) {
  const [days, setDays] = useState(
    String(value.kind === "days" ? value.days : 30),
  );
  const [at, setAt] = useState(
    toLocalInput(
      value.kind === "at" ? value.at : new Date(now + 30 * DAY).toISOString(),
    ),
  );

  const pickMode = (m: Mode) => {
    if (m === value.kind) return;
    if (m === "never") onChange({ kind: "never" });
    else if (m === "days")
      onChange({ kind: "days", days: parseDays(days) ?? 30 });
    else onChange({ kind: "at", at: new Date(at).toISOString() });
  };

  return (
    <div className="vr-expiry">
      <Segmented
        size="sm"
        aria-label="有效期方式"
        value={value.kind}
        onChange={pickMode}
        options={MODES}
      />
      {value.kind === "days" && (
        <span className="vr-inline">
          <Input
            type="number"
            min={1}
            max={DAYS_MAX}
            aria-label="过期天数"
            className="vr-days"
            value={days}
            onChange={(e) => {
              setDays(e.target.value);
              const n = parseDays(e.target.value);
              if (n !== null && n !== value.days)
                onChange({ kind: "days", days: n });
            }}
          />
          <span className="t-aux">天</span>
        </span>
      )}
      {value.kind === "at" && (
        <Input
          type="datetime-local"
          aria-label="到期时间"
          value={at}
          onChange={(e) => {
            setAt(e.target.value);
            const t = Date.parse(e.target.value);
            if (!Number.isNaN(t))
              onChange({ kind: "at", at: new Date(t).toISOString() });
          }}
        />
      )}
    </div>
  );
}
