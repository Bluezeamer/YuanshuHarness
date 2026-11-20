// 对话流里的压缩边界卡：默认折叠，展开看压缩摘要、压缩前 token 与时间。
// 让压缩后的会话序列仍能按原样读：卡片标出上下文被压缩的位置，前后的消息都还在。

import { useState } from "react";
import type { CompactionAnchor } from "../../../api";
import { Button } from "../../../ui";
import { ChevronRightIcon } from "../../../ui/icons";
import { StackGlyph } from "./glyphs";

const fmtTok = (n: number): string => n.toLocaleString("en-US");

// 本地时间 `MM-DD HH:MM`；解析不了的原样返回
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function CompactionCard({ c }: { c: CompactionAnchor }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ch-compact" data-compaction={c.seq}>
      <Button
        variant="ghost"
        size="sm"
        className="ch-compact-h"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <StackGlyph size={11} />
        压缩历史 {c.seq}
        <ChevronRightIcon className="ch-compact-x" size={12} />
      </Button>
      {open && (
        <div className="ch-compact-body">
          <p className="ch-compact-meta t-mono">
            {fmtWhen(c.createdAt)} · 压缩前 {fmtTok(c.tokensBefore)} tok
          </p>
          <p className="ch-compact-sum t-plain">
            {c.summary || "（没有摘要）"}
          </p>
        </div>
      )}
    </div>
  );
}
