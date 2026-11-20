// 已保存登录状态的读取与操作：动作立即执行，结果弹提示；失败时留在原状态。
import { useCallback, useEffect, useState } from "react";
import {
  clearLogins,
  type LoginMeta,
  listLogins,
  removeLogin,
  setLoginEnabled,
} from "../../../api/browser";
import { loadToken } from "../../../api/http";
import { toast } from "../../../ui";

export type LoginsState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; logins: LoginMeta[] };

export function useLogins() {
  const [state, setState] = useState<LoginsState>({ phase: "loading" });

  const load = useCallback(async () => {
    const r = await listLogins(loadToken());
    setState(
      r.ok
        ? { phase: "ready", logins: r.data }
        : { phase: "error", message: "读取登录状态失败，请重试" },
    );
  }, []);
  useEffect(() => void load(), [load]);

  /** 动作成功后重新读一遍，列表以服务端为准。 */
  const act = async (
    call: () => Promise<{ ok: true } | { ok: false; message: string }>,
    done: string,
  ) => {
    const r = await call();
    if (!r.ok) return toast(r.message, { tone: "danger" });
    toast(done, { tone: "ok" });
    await load();
  };

  return {
    state,
    reload: load,
    toggle: (site: string, enabled: boolean) =>
      act(
        () => setLoginEnabled(loadToken(), site, enabled),
        enabled ? `${site} 的登录状态已允许 agent 使用` : `已停用 ${site}`,
      ),
    remove: (site: string) =>
      act(() => removeLogin(loadToken(), site), `已删除 ${site} 的登录状态`),
    clear: () => act(() => clearLogins(loadToken()), "已清空全部登录状态"),
  };
}
