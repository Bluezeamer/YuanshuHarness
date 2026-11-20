// 工作区里此刻在监听的服务端口：页面列表每次打开时取一次（服务端会真去连一下确认），取不到就当没有。
import { useEffect, useState } from "react";
import { getPorts, type PortView } from "../../../api/browser";
import { loadToken } from "../../../api/http";

export function usePorts(
  workspaceId: string,
  open: boolean,
): readonly PortView[] {
  const [ports, setPorts] = useState<readonly PortView[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void getPorts(loadToken(), workspaceId).then((r) => {
      if (alive) setPorts(r.ok ? r.data : []);
    });
    return () => {
      alive = false;
    };
  }, [workspaceId, open]);
  return ports;
}
