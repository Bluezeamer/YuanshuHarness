import { useState } from "react";

// 拖放状态：左边的段列表和右边的内容共用，所以放在页面里。
// drag 是被拖的条目键（cardKey / groupKey），over 是当前悬停的落点。
export function useDnd() {
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  return { drag, setDrag, over, setOver };
}
export type Dnd = ReturnType<typeof useDnd>;
