import { useState } from "react";
import { ListRow } from "../../../ui";
import { ChevronDownIcon, ChevronRightIcon } from "../../../ui/icons";

// 思考：默认一行「思考」，点开看全文
export function Think({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ch-think">
      <ListRow
        size="compact"
        lead={open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        label={<span className="t-aux">思考</span>}
        expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open && <p className="ch-think-body t-aux">{text}</p>}
    </div>
  );
}
