import { useCallback, useEffect, useState } from "react";
import {
  type AgentSettingsView,
  getAgentSettings,
  putAgentSettings,
} from "../../../api/agentSettings";
import { getDefaultModel, putDefaultModel } from "../../../api/defaultModel";
import { getDefaults, putDefaults } from "../../../api/defaults";
import { loadToken } from "../../../api/http";
import { listProviders, type ProviderView } from "../../../api/providers";
import { agentPatchOf } from "./agent";
import { messageOf } from "./errors";
import {
  changesOf,
  type DefaultsForm,
  errorsOf,
  formOf,
  fromAgent,
  fromDefaults,
} from "./model";

export type DefaultsState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      providers: ProviderView[];
      saved: DefaultsForm;
      /** 压缩与重试的落盘文件、pi 自己的取值、被忽略的项；表单里的值在 saved 里 */
      agent: AgentSettingsView;
    };

/**
 * 全局默认值：打开时一次读齐成一份表单；save 只发与已保存值不同的项（默认模型、压缩与重试、其余分属三个接口）。
 * 返回 null = 成功，否则是给人看的一句话；某个接口失败不影响其余，已存上的部分并进「已保存」。
 */
export function useDefaults() {
  const [state, setState] = useState<DefaultsState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 只用来触发重试
  useEffect(() => {
    let alive = true;
    setState({ phase: "loading" });
    const token = loadToken();
    Promise.all([
      listProviders(token),
      getDefaultModel(token),
      getDefaults(token),
      getAgentSettings(token),
    ]).then(
      ([providers, def, d, agent]) =>
        alive &&
        setState({
          phase: "ready",
          providers,
          saved: formOf(def, d, agent),
          agent,
        }),
      (e) => alive && setState({ phase: "error", message: messageOf(e) }),
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const merge = (next: Partial<DefaultsForm>) =>
    setState((s) =>
      s.phase === "ready" ? { ...s, saved: { ...s.saved, ...next } } : s,
    );

  const save = async (draft: DefaultsForm): Promise<string | null> => {
    if (state.phase !== "ready") return "还没读完，稍后再试";
    if (Object.keys(errorsOf(draft)).length > 0)
      return "有填写不合法的项，先改正";
    const { model, defaults } = changesOf(draft, state.saved);
    const agentPatch = agentPatchOf(draft, state.saved, state.agent.defaults);
    const token = loadToken();
    const failed: string[] = [];
    if (Object.keys(defaults).length > 0) {
      try {
        merge(fromDefaults(await putDefaults(token, defaults)));
      } catch (e) {
        failed.push(messageOf(e));
      }
    }
    if (Object.keys(agentPatch).length > 0) {
      try {
        const agent = await putAgentSettings(token, agentPatch);
        setState((s) =>
          s.phase === "ready"
            ? { ...s, agent, saved: { ...s.saved, ...fromAgent(agent) } }
            : s,
        );
      } catch (e) {
        failed.push(`压缩与重试：${messageOf(e)}`);
      }
    }
    if (model) {
      try {
        merge({
          model: await putDefaultModel(token, {
            provider: model.provider,
            model: model.model,
            ...(model.thinking ? { thinking: model.thinking } : {}),
          }),
        });
      } catch (e) {
        failed.push(`默认模型：${messageOf(e)}`);
      }
    }
    return failed.length > 0 ? failed.join("；") : null;
  };

  return { state, retry, save };
}
