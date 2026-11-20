// 设备列表的读取与撤销：动作立即执行，结果弹提示；列表以服务端为准。
import { useCallback, useEffect, useState } from "react";
import {
  type DeviceView,
  listDevices,
  removeDevice,
} from "../../../api/devices";
import { loadToken } from "../../../api/http";
import { toast } from "../../../ui";

export type DevicesState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; devices: DeviceView[] };

export function useDevices() {
  const [state, setState] = useState<DevicesState>({ phase: "loading" });

  const load = useCallback(async () => {
    const r = await listDevices(loadToken());
    setState(r.ok ? { phase: "ready", devices: r.data } : { phase: "error" });
    return r.ok ? r.data : null;
  }, []);
  useEffect(() => void load(), [load]);

  const revoke = async (d: DeviceView) => {
    const r = await removeDevice(loadToken(), d.id);
    if (r.ok || r.kind === "not_found")
      toast(`已撤销「${d.name}」`, { tone: "ok" });
    else toast("撤销失败，请重试", { tone: "danger" });
    await load();
  };

  return { state, load, revoke };
}
