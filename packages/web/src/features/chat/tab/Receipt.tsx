import { Chip, Dot } from "../../../ui";

// 系统回执：一行（状态点 + 说明 + 时间 + 右侧徽标：/goal、/goal · 编辑、/compact …），有备注时下面再补一行。
// 压缩回执由 flowLog 观察快照得出，目标回执来自服务端的目标卡片（GoalNotice）。
export interface ReceiptView {
  kind: string;
  badge: string;
  text: string;
  /** 额外一行说明，如出错信息 */
  note?: string;
  time: string;
}

export function Receipt({ r }: { r: ReceiptView }) {
  return (
    <div className="ch-msg ch-sys" data-kind={r.kind}>
      <div className="ch-sys-head">
        <Dot size="sm" tone="idle" />
        <span className="ch-arg t-plain">{r.text}</span>
        {r.time && <span className="t-mono">{r.time}</span>}
        <Chip className="ch-sys-badge t-mono">{r.badge}</Chip>
      </div>
      {r.note && <p className="ch-sys-note t-aux">{r.note}</p>}
    </div>
  );
}
