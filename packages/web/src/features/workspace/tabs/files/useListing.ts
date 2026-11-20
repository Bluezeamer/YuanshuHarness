// 目录列表的加载状态：加载中 / 就绪 / 错误三态；同一路径刷新时保留旧列表，换路径才清空。
import { useCallback, useEffect, useRef, useState } from "react";
import { type FileListing, listFiles } from "../../../../api/files";
import { type CallFailure, loadToken } from "../../../../api/http";

export type ListState =
  | { status: "loading"; listing: null }
  | { status: "ready"; listing: FileListing; refreshing: boolean }
  | { status: "error"; kind: CallFailure["kind"]; listing: FileListing | null };

const WHY: Record<CallFailure["kind"], string> = {
  unauthorized: "登录已失效，请重新输入访问令牌",
  forbidden: "没有权限读取这个目录",
  rate_limited: "请求太频繁，稍后再试",
  network: "网络不通，连不上 Server",
  server: "Server 出错了",
  bad_request: "路径无效",
  not_found: "目录不存在，或这台主机的连接已断开",
  conflict: "同名的项已存在",
};

/** 失败原因的中文说明（列表、新建、重命名、删除共用） */
export const failText = (kind: CallFailure["kind"]): string => WHY[kind];

export function useListing(env: string, path: string, hidden: boolean) {
  const [state, setState] = useState<ListState>({
    status: "loading",
    listing: null,
  });
  // 只认最后一次请求的结果，切换路径时迟到的旧响应直接丢弃
  const seq = useRef(0);
  const key = `${env}\0${path}\0${hidden}`;
  const lastKey = useRef(key);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const r = await listFiles(loadToken(), env, path, hidden);
    if (mine !== seq.current) return;
    setState((s) =>
      r.ok
        ? { status: "ready", listing: r.data, refreshing: false }
        : { status: "error", kind: r.kind, listing: s.listing },
    );
  }, [env, path, hidden]);

  useEffect(() => {
    // 换了环境/路径/隐藏开关：先回到加载态，再取
    if (lastKey.current !== key) {
      lastKey.current = key;
      setState({ status: "loading", listing: null });
    }
    void load();
    return () => void seq.current++;
  }, [key, load]);

  /** 刷新：保留旧列表，只标记 refreshing */
  const reload = useCallback(() => {
    setState((s) => (s.status === "ready" ? { ...s, refreshing: true } : s));
    void load();
  }, [load]);

  return { state, reload };
}
