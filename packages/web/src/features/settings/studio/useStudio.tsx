// 提示词与能力页的共享数据：预设清单、卡片库、供应商与模型。未保存修改的离开确认在设置壳里（frame/leave）。
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { getDefaultModel } from "../../../api/defaultModel";
import { loadToken } from "../../../api/http";
import { listProviders } from "../../../api/providers";
import {
  listCards,
  listPresets,
  type StudioCard,
  type StudioCardGroup,
  type StudioPreset,
} from "../../../api/studio";
import {
  type ModelRef,
  type ProviderChoice,
  providerChoices,
} from "./model/eval";

export interface StudioData {
  presets: StudioPreset[];
  groups: StudioCardGroup[];
  cards: ReadonlyMap<string, StudioCard>;
  providers: ProviderChoice[];
  /** 全局默认模型：预览「按这个模型求值」的起点 */
  defaultModel: ModelRef | null;
  reload: () => Promise<void>;
}

const Ctx = createContext<StudioData | null>(null);

export const useStudio = (): StudioData => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStudio 要在 StudioProvider 里用");
  return v;
};

type Load =
  | { phase: "loading" }
  | { phase: "error" }
  | {
      phase: "ready";
      presets: StudioPreset[];
      groups: StudioCardGroup[];
      providers: ProviderChoice[];
      defaultModel: ModelRef | null;
    };

export function StudioProvider({
  children,
  fallback,
}: {
  children: ReactNode;
  /** 加载中 / 失败时代替页面显示的内容 */
  fallback: (phase: "loading" | "error", retry: () => void) => ReactNode;
}) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });

  const fetchAll = useCallback(async (): Promise<Load> => {
    const [p, c] = await Promise.all([listPresets(), listCards()]);
    if (!p.ok || !c.ok) return { phase: "error" };
    // 供应商清单与默认模型只用来选条件、做预览，取不到不挡着整个页面
    const token = loadToken();
    const [providers, defaultModel] = await Promise.all([
      listProviders(token)
        .then(providerChoices)
        .catch(() => []),
      getDefaultModel(token).catch(() => null),
    ]);
    return {
      phase: "ready",
      presets: p.data,
      groups: c.data,
      providers,
      defaultModel,
    };
  }, []);

  const reload = useCallback(async () => {
    const next = await fetchAll();
    if (next.phase === "ready") setLoad(next);
  }, [fetchAll]);

  const retry = useCallback(() => {
    setLoad({ phase: "loading" });
    void fetchAll().then(setLoad);
  }, [fetchAll]);
  useEffect(retry, [retry]);

  const value = useMemo<StudioData | null>(
    () =>
      load.phase === "ready"
        ? {
            presets: load.presets,
            groups: load.groups,
            cards: new Map(
              load.groups.flatMap((g) => g.cards).map((c) => [c.id, c]),
            ),
            providers: load.providers,
            defaultModel: load.defaultModel,
            reload,
          }
        : null,
    [load, reload],
  );

  return value ? (
    <Ctx.Provider value={value}>{children}</Ctx.Provider>
  ) : (
    fallback(load.phase === "error" ? "error" : "loading", retry)
  );
}
