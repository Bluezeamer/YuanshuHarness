// 工作区里转发出来的服务：页面列表每次打开时取一次；开与停之后重新取，列表以服务端为准。
import { useCallback, useEffect, useState } from "react";
import {
  closeForward,
  type ForwardView,
  getForwards,
  openForward,
} from "../../../api/browser";
import { loadToken } from "../../../api/http";

export function useForwards(workspaceId: string, open: boolean) {
  const [forwards, setForwards] = useState<readonly ForwardView[]>([]);

  const reload = useCallback(async () => {
    const r = await getForwards(loadToken(), workspaceId);
    setForwards(r.ok ? r.data : []);
  }, [workspaceId]);
  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  return {
    forwards,
    /** 转发这个目标（`3000`、`server:3000`、`box:8080`）；失败返回中文原因（data 是转发视图）。 */
    open: async (target: string) => {
      const r = await openForward(loadToken(), workspaceId, target);
      if (r.ok) await reload();
      return r;
    },
    stop: async (id: string) => {
      const r = await closeForward(loadToken(), workspaceId, id);
      if (r.ok) await reload();
      return r;
    },
  };
}
