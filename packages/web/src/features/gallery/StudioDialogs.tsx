import { useState } from "react";
import { Button, InlineNotice, Segmented, SummaryRow } from "../../ui";

const AGENT_OPTS = ["coder-full", "reviewer"];

type Row = {
  k: string;
  label: string;
  global: string;
  own: string | null;
};

const ROWS: Row[] = [
  { k: "agent", label: "默认 Agent", global: "coder-full", own: null },
  { k: "model", label: "模型", global: "claude-sonnet-5", own: "Qwen3.8-27B" },
  { k: "think", label: "思考强度", global: "medium", own: "low" },
  { k: "perm", label: "权限", global: "规则", own: null },
  { k: "modes", label: "可用模式", global: "plan、review", own: null },
  { k: "subs", label: "子代理清单", global: "（无）", own: "explorer" },
];

// 视图 4：工作区「新会话默认配置」。每一行显示值与来源，覆盖了就给「恢复跟随」；展开后第一项是「跟随全局 · X」。
export function DefaultsView() {
  const [own, setOwn] = useState<Record<string, string | null>>(
    Object.fromEntries(ROWS.map((r) => [r.k, r.own])),
  );
  const [open, setOpen] = useState<string | null>("perm");
  const n = Object.values(own).filter((v) => v !== null).length;
  return (
    <div className="gl-page">
      <div className="gl-head">
        <div>
          <div className="t-page">新会话默认配置</div>
          <div className="t-aux">
            工作区「项目甲」· 只在新建对话时套用，已有对话不受影响
          </div>
        </div>
        <Button
          variant="outline"
          disabled={n === 0}
          onClick={() =>
            setOwn(Object.fromEntries(ROWS.map((r) => [r.k, null])))
          }
        >
          全部恢复跟随
        </Button>
      </div>
      <InlineNotice>
        {n === 0
          ? "全部跟随全局默认。"
          : `${n} 项已覆盖，其余跟随全局默认：全局改了，这里没覆盖的项跟着变。`}
      </InlineNotice>
      <div className="gl-sum">
        {ROWS.map((r) => {
          const v = own[r.k];
          const shown = v ?? r.global;
          return (
            <div key={r.k}>
              <SummaryRow
                label={r.label}
                value={shown}
                note={v === null ? "跟随全局" : `已覆盖 · 全局是 ${r.global}`}
                onOpen={() => setOpen(open === r.k ? null : r.k)}
                {...(v !== null
                  ? { onReset: () => setOwn({ ...own, [r.k]: null }) }
                  : {})}
              />
              {open === r.k && (
                <div className="gl-sum-open">
                  <Segmented
                    aria-label={r.label}
                    options={
                      r.k === "perm"
                        ? [
                            { value: "", label: `跟随全局 · ${r.global}` },
                            { value: "规则", label: "规则" },
                            { value: "模型", label: "模型", disabled: true },
                            { value: "通过", label: "通过" },
                          ]
                        : [
                            { value: "", label: `跟随全局 · ${r.global}` },
                            ...(r.k === "agent" ? AGENT_OPTS : [shown]).map(
                              (x) => ({ value: x, label: x }),
                            ),
                          ]
                    }
                    value={v ?? ""}
                    onChange={(x) => setOwn({ ...own, [r.k]: x || null })}
                  />
                  {r.k === "perm" && (
                    <div className="t-aux">
                      「模型」档要先在设置里配审批模型。
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
