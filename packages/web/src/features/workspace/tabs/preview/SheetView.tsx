// 表格预览：SheetJS 解析 xlsx/xls/csv/tsv，自己画只读表（多 sheet 用 tab 切换）。
// 不用 Univer 这类完整表格引擎：实测它的包比 SheetJS 大一个量级，只读预览用不上。
import { useEffect, useState } from "react";
import { Button, InlineNotice } from "../../../../ui";

interface Sheet {
  name: string;
  rows: string[][];
}

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; sheets: Sheet[] }
  | { kind: "failed" };

export function SheetView({
  bytes,
  name,
}: {
  bytes: Uint8Array;
  /** 文件名：csv/tsv 没有表名，用文件名当唯一 sheet 的名字。 */
  name: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [active, setActive] = useState(0);

  useEffect(() => {
    let alive = true;
    setPhase({ kind: "loading" });
    void (async () => {
      try {
        const XLSX = await import("xlsx");
        if (!alive) return;
        const wb = XLSX.read(bytes, { type: "array" });
        const sheets: Sheet[] = wb.SheetNames.map((n) => {
          const ws = wb.Sheets[n];
          const rows = ws
            ? (XLSX.utils.sheet_to_json(ws, {
                header: 1,
                raw: false,
                defval: "",
                blankrows: false,
              }) as unknown as string[][])
            : [];
          return { name: n, rows };
        });
        setActive(0);
        setPhase({ kind: "ready", sheets });
      } catch {
        if (alive) setPhase({ kind: "failed" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [bytes]);

  if (phase.kind === "loading")
    return (
      <p className="ws-pv-note t-aux" role="status">
        正在解析表格…
      </p>
    );
  if (phase.kind === "failed")
    return (
      <InlineNotice tone="danger" className="ws-pv-note-bad">
        这个表格解析不了：可能已加密或已损坏。
      </InlineNotice>
    );

  const sheet = phase.sheets[active] ?? phase.sheets[0];
  return (
    <div className="ws-pv-sheet">
      {phase.sheets.length > 1 && (
        <div className="ws-pv-tabs" role="tablist" aria-label="工作表">
          {phase.sheets.map((s, i) => (
            <Button
              // biome-ignore lint/suspicious/noArrayIndexKey: 工作表按位置排列，重名表靠位置区分
              key={`${s.name}-${i}`}
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={i === active}
              className="ws-pv-tab"
              onClick={() => setActive(i)}
            >
              {s.name}
            </Button>
          ))}
        </div>
      )}
      {!sheet || sheet.rows.length === 0 ? (
        <p className="ws-pv-note t-aux">
          {sheet ? sheet.name : name} 里没有内容。
        </p>
      ) : (
        <div className="ws-pv-grid-wrap">
          <table className="ws-pv-grid t-aux">
            <tbody>
              {sheet.rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 表格行列位置即身份，内容只读
                <tr key={r}>
                  {row.map((cell, c) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                    <td key={c}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
