// 浏览器下载镜像的读取与保存：存在全局默认值里（/defaults 的 browserMirror），这里只取这一项。
import { useCallback, useEffect, useState } from "react";
import { getDefaults, putDefaults } from "../../../api/defaults";
import { ApiError, loadToken } from "../../../api/http";
import { describeError } from "../providers/errors";
import { mirrorError } from "./model";

export type MirrorState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; saved: string };

const messageOf = (e: unknown): string =>
  e instanceof ApiError && e.code === "invalid_browser_mirror"
    ? "镜像地址要以 http 或 https 开头，最长 512 个字符。"
    : describeError(e).message;

export function useMirror() {
  const [state, setState] = useState<MirrorState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 只用来触发重试
  useEffect(() => {
    let alive = true;
    setState({ phase: "loading" });
    getDefaults(loadToken()).then(
      (d) => alive && setState({ phase: "ready", saved: d.browserMirror }),
      (e) => alive && setState({ phase: "error", message: messageOf(e) }),
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  /** 返回 null = 成功，否则是给人看的一句话（useDraft 的约定）。 */
  const save = async (draft: string): Promise<string | null> => {
    const bad = mirrorError(draft);
    if (bad) return bad;
    try {
      const d = await putDefaults(loadToken(), { browserMirror: draft });
      setState({ phase: "ready", saved: d.browserMirror });
      return null;
    } catch (e) {
      return messageOf(e);
    }
  };

  return {
    state,
    retry: useCallback(() => setAttempt((n) => n + 1), []),
    save,
  };
}
