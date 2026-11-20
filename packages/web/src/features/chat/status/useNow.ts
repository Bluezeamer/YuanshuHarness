import { useEffect, useState } from "react";

/** 每隔一会儿刷新的「现在」；on 为 false 时不走表。折叠与「N 分钟前」靠它随时间变化。 */
export function useNow(on: boolean, ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}
