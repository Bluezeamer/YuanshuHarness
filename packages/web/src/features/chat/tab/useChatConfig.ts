// 输入栏的数据：会话配置（模型 / 能力 / 权限档位）、已连接供应商、会话上下文（技能与 MCP 实况）。
// 各项各自容错：取不到只是对应入口少一块信息，不挡发送。

import { useCallback, useEffect, useRef, useState } from "react";
import { type DefaultModel, getDefaultModel } from "../../../api/defaultModel";
import { type Defaults, getDefaults } from "../../../api/defaults";
import { getSessionContext, type SessionContext } from "../../../api/flows";
import { ApiError, loadToken } from "../../../api/http";
import { listProviders, type ProviderView } from "../../../api/providers";
import {
  type ConfigPatch,
  conflictOf,
  getSessionConfig,
  patchSessionConfig,
  type SessionConfig,
} from "../../../api/sessionConfig";
import { toast } from "../../../ui";

export interface ChatConfig {
  sessionId: string;
  config: SessionConfig | null;
  providers: ProviderView[];
  /** 全局默认模型；会话模型跟随默认时，这就是实际用的模型 */
  defaultModel: DefaultModel | null;
  /** 全局默认值：权限档位跟随的就是它里面的档位 */
  defaults: Defaults | null;
  /** 重新读全局默认值（打开权限菜单时调用，别处改过也能看到） */
  reloadDefaults(): void;
  /** 会话生效的技能与 MCP（服务端算好的，不是预设里的字面值） */
  context: SessionContext | null;
  /** 重新读会话上下文视图（MCP 的连接状态会变：重载之后、打开斜杠菜单时）；与左轨的「刷新上下文」无关 */
  refetchContext(): void;
  /** 提交一份会话配置补丁；成功返回 true，失败已提示 */
  patch(p: ConfigPatch): Promise<boolean>;
}

const soft = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

const REASON: Record<string, string> = {
  unknown_model: "服务端模型登记里没有这个模型",
  bad_reasoning: "这个模型不支持所选的思考级别",
  unknown_tool: "能力列表里有不认识的内置工具",
  review_model_missing: "「模型」档要先在设置里配审批模型",
};

export function useChatConfig(sessionId: string): ChatConfig {
  const [config, setConfig] = useState<SessionConfig | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [defaultModel, setDefaultModel] = useState<DefaultModel | null>(null);
  const [context, setContext] = useState<SessionContext | null>(null);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const latest = useRef<SessionConfig | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  latest.current = config;

  useEffect(() => {
    let alive = true;
    const token = loadToken();
    void (async () => {
      const [cfg, ps, dm, ctx, df] = await Promise.all([
        soft(getSessionConfig(token, sessionId)),
        soft(listProviders(token)),
        soft(getDefaultModel(token)),
        soft(getSessionContext(token, sessionId)),
        soft(getDefaults(token)),
      ]);
      if (!alive) return;
      if (cfg) setConfig(cfg);
      setDefaultModel(dm);
      setDefaults(df);
      if (Array.isArray(ps)) setProviders(ps);
      if (ctx?.ok) setContext(ctx.data);
    })();
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const refetchContext = useCallback(() => {
    void getSessionContext(loadToken(), sessionId).then((r) => {
      if (r.ok) setContext(r.data);
    });
  }, [sessionId]);

  const reloadDefaults = useCallback(() => {
    void getDefaults(loadToken()).then(setDefaults, () => {});
  }, []);

  // 补丁串行提交：每次都读最新的 rev，连点两下不会互相 409。
  const patch = useCallback(
    (p: ConfigPatch) => {
      const run = async (): Promise<boolean> => {
        const cur = latest.current;
        if (!cur) return false;
        try {
          const r = await patchSessionConfig(
            loadToken(),
            sessionId,
            cur.rev,
            p,
          );
          latest.current = r.config;
          setConfig(r.config);
          return true;
        } catch (err) {
          const theirs = conflictOf(err);
          if (theirs) {
            latest.current = theirs;
            setConfig(theirs);
            toast("会话配置已被其他端修改，已刷新，请重试", { tone: "warn" });
          } else {
            const code = err instanceof ApiError ? err.code : null;
            toast(`保存失败：${(code && REASON[code]) ?? code ?? "网络不通"}`, {
              tone: "danger",
            });
          }
          return false;
        }
      };
      const next = queue.current.then(run, run);
      queue.current = next;
      return next;
    },
    [sessionId],
  );

  return {
    sessionId,
    config,
    providers,
    defaultModel,
    defaults,
    reloadDefaults,
    context,
    refetchContext,
    patch,
  };
}
