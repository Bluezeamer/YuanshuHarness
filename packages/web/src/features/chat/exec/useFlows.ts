// 执行体清单与会话上下文的取数钩子；右侧状态栏与执行体标签共用。
// 重取时机：会话快照与 flows.updated（flowsRev）、context.updated（contextRev）、
// 以及有运行中执行体时每 3 秒一次——子代理执行中的工具调用与 ctx 增长不会触发 flows.updated。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Flows,
  getFlows,
  getSessionContext,
  type SessionContext,
} from "../../../api/flows";
import { type CallResult, loadToken } from "../../../api/http";
import { type JobInfo, listJobs } from "../../../api/jobs";
import { getTeam, type TeamView } from "../../../api/team";
import { rememberJob } from "../job/names";
import { rememberExecutions } from "./names";

export const POLL_MS = 3000;
/** 团队改动每次都要比对目录，轮询得慢一些 */
export const TEAM_POLL_MS = 10_000;

export interface Slice<T> {
  data: T | null;
  /** 首次载入中 */
  loading: boolean;
  /** 最近一次请求失败的说明；data 仍保留上一份 */
  error: string | null;
  reload(): void;
}

const WHY: Record<string, string> = {
  not_found: "会话不存在，或已被删除",
  bad_request: "请求无效",
  conflict: "状态冲突，请重试",
  network: "网络不通",
  unauthorized: "令牌无效，请重新登录",
  forbidden: "没有权限查看",
  rate_limited: "请求过于频繁，稍后再试",
  server: "服务端出错",
};

interface Box<T> {
  sid: string;
  data: T | null;
  error: string | null;
  loading: boolean;
}

// 带会话切换保护的单个接口取数：晚到的响应一律丢弃，换会话时旧数据视为没有。
function useFetched<T>(
  sessionId: string,
  fetcher: (token: string | null, sid: string) => Promise<CallResult<T>>,
  rev: number,
  pollWhile?: (d: T) => boolean,
  onData?: (d: T) => void,
  pollMs = POLL_MS,
): Slice<T> {
  const [box, setBox] = useState<Box<T>>({
    sid: sessionId,
    data: null,
    error: null,
    loading: true,
  });
  const cur =
    box.sid === sessionId
      ? box
      : { sid: sessionId, data: null, error: null, loading: true };
  const gen = useRef(0);
  const keep = useRef({ fetcher, onData });
  keep.current = { fetcher, onData };

  const reload = useCallback(() => {
    const g = ++gen.current;
    void keep.current.fetcher(loadToken(), sessionId).then((r) => {
      if (g !== gen.current) return;
      if (r.ok) keep.current.onData?.(r.data);
      setBox((b) => {
        const base = b.sid === sessionId ? b : { sid: sessionId, data: null };
        return r.ok
          ? { sid: sessionId, data: r.data, error: null, loading: false }
          : {
              sid: sessionId,
              data: base.data,
              error: WHY[r.kind] ?? WHY.server ?? "",
              loading: false,
            };
      });
    });
  }, [sessionId]);

  // rev 变化（含首次与换会话）即重取
  // biome-ignore lint/correctness/useExhaustiveDependencies: rev 是触发重取的版本号，函数体里不读它
  useEffect(() => {
    reload();
    return () => {
      gen.current++;
    };
  }, [reload, rev]);

  const poll = cur.data !== null && pollWhile?.(cur.data) === true;
  useEffect(() => {
    if (!poll) return;
    const t = setInterval(reload, pollMs);
    return () => clearInterval(t);
  }, [poll, reload, pollMs]);

  return { data: cur.data, loading: cur.loading, error: cur.error, reload };
}

const hasLive = (f: Flows) => f.executions.some((x) => x.state === "run");

/** 执行体清单；右侧状态与执行体标签共用，顺带把名称记进缓存供标签标题使用。rev 是会话里的 flowsRev，变了就重取 */
export function useFlows(sessionId: string, rev: number): Slice<Flows> {
  return useFetched(sessionId, getFlows, rev, hasLive, (f) =>
    rememberExecutions(f.executions),
  );
}

/** 会话名下的后台任务清单（顺带把简述记进缓存供任务标签的标题用）；rev 是会话里的 jobsRev（任务登记 / 结束、回调卡到达都会加 1） */
export function useJobs(sessionId: string, rev: number): Slice<JobInfo[]> {
  return useFetched(sessionId, listJobs, rev, undefined, (jobs) =>
    jobs.forEach(rememberJob),
  );
}

/** 会话已加载的技能 / MCP；rev 是会话里的 contextRev */
export function useSessionContext(
  sessionId: string,
  rev: number,
): Slice<SessionContext> {
  return useFetched(sessionId, getSessionContext, rev);
}

const noTeam = async (): Promise<CallResult<TeamView>> => ({
  ok: false,
  kind: "not_found",
});

/**
 * 团队的公告板与改动清单；没有成员（on 为 false）时不发请求。rev 是会话里的 flowsRev，
 * live 为 true（有成员在跑）时每 10 秒再取一次：成员发公告、改文件不会触发 flows.updated。
 */
export function useTeam(
  sessionId: string,
  rev: number,
  on: boolean,
  live: boolean,
): Slice<TeamView> {
  return useFetched(
    sessionId,
    on ? getTeam : noTeam,
    // 0 = 关；开了之后随 rev 变（从 1 起），开关本身的变化也触发一次重取
    on ? rev + 1 : 0,
    () => live,
    undefined,
    TEAM_POLL_MS,
  );
}
