// 壳要补的外部数据：主机清单（连接列表）。工作区、会话、布局都由 features/workspace 自己的库层管。
import { useEffect, useMemo, useRef, useState } from "react";
import { type ConnectionList, listConnections } from "../../api/connections";
import { loadToken } from "../../api/http";
import type { HostInfo } from "../../features/workspace/layoutContext";
import { hostsOf } from "./hosts";

export function useShellHosts(): readonly HostInfo[] {
  const [conns, setConns] = useState<ConnectionList | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    // 连接列表取失败不挡界面：只有 Server 本机一个主机
    listConnections(loadToken()).then(
      (c) => {
        if (alive.current) setConns(c);
      },
      () => {},
    );
    return () => {
      alive.current = false;
    };
  }, []);
  return useMemo(() => hostsOf(conns), [conns]);
}
