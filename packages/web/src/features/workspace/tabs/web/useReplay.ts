// 回放的数据：会话列表、当前会话的步、步的画面。画面接口要带令牌，所以取成 Blob 再变成 object URL，
// 缓存在这个 hook 里（换会话或卸载时统一释放）；看到第几步就顺手取前后几步，翻起来不等。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getReplayFrame,
  getReplaySessions,
  getReplaySteps,
  type ReplaySession,
  type ReplayStep,
} from "../../../../api/browser";
import { loadToken } from "../../../../api/http";
import { indexAfterReload, pickSession } from "./replayModel";

/** 取当前步前后各几步的画面。 */
const PREFETCH_BEHIND = 1;
const PREFETCH_AHEAD = 2;

export interface ReplayState {
  /** null = 还在读取 */
  sessions: ReplaySession[] | null;
  sid: string | null;
  steps: ReplayStep[];
  index: number;
  /** 当前步的画面（object URL）；还没取到是 null */
  frame: string | null;
  /** 当前步的画面服务端已经没有了（文件被清掉或读不出来） */
  missing: boolean;
  /** 第 i 步已经有结果（取到了或确认没有）：自动播放据此等一等 */
  settled(index: number): boolean;
  /** 列表读取失败（连不上 Server） */
  failed: boolean;
  selectSession(sid: string): void;
  setIndex(index: number): void;
  reload(): void;
}

export function useReplay(
  workspaceId: string,
  anchor: string | null,
): ReplayState {
  const [sessions, setSessions] = useState<ReplaySession[] | null>(null);
  const [sid, setSid] = useState<string | null>(null);
  // 步带着它属于哪个会话：换会话的那一刻旧会话的步不能拿来取新会话的画面
  const [data, setData] = useState<{
    sid: string;
    steps: ReplayStep[];
  } | null>(null);
  const [index, setIndexState] = useState(0);
  const [frames, setFrames] = useState<Readonly<Record<number, string | null>>>(
    {},
  );
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);

  // 重新读取前的位置，indexAfterReload 据此决定看哪一步
  const before = useRef<{ ids: number[]; index: number } | null>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const sidRef = useRef(sid);
  sidRef.current = sid;
  const made = useRef(new Set<string>());
  const asked = useRef(new Set<number>());

  const token = loadToken();
  const steps = data !== null && data.sid === sid ? data.steps : [];

  // 会话列表：打开与「刷新」时读；当前会话还在就不动，没了（或还没选）按默认挑一个
  // biome-ignore lint/correctness/useExhaustiveDependencies: token 来自 sessionStorage，组件生命期内不变
  useEffect(() => {
    let alive = true;
    void getReplaySessions(token, workspaceId).then((r) => {
      if (!alive) return;
      setFailed(!r.ok);
      const list = r.ok ? r.data : [];
      setSessions(list);
      if (!list.some((s) => s.sessionId === sidRef.current))
        setSid(pickSession(list, anchorRef.current));
    });
    return () => {
      alive = false;
    };
  }, [workspaceId, round]);

  // 当前会话的步
  // biome-ignore lint/correctness/useExhaustiveDependencies: 同上
  useEffect(() => {
    if (sid === null) return;
    let alive = true;
    void getReplaySteps(token, workspaceId, sid).then((r) => {
      if (!alive) return;
      const next = r.ok ? r.data : [];
      setData({ sid, steps: next });
      setIndexState(
        indexAfterReload(
          before.current,
          next.map((s) => s.id),
        ),
      );
      before.current = null;
    });
    return () => {
      alive = false;
    };
  }, [workspaceId, sid, round]);

  // 换会话与卸载：旧会话的画面全部释放
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在会话变化时清
  useEffect(
    () => () => {
      for (const url of made.current) URL.revokeObjectURL(url);
      made.current.clear();
      asked.current.clear();
      setFrames({});
    },
    [sid],
  );

  // 看到第几步，顺手取前后几步的画面
  // biome-ignore lint/correctness/useExhaustiveDependencies: 同上
  useEffect(() => {
    if (sid === null) return;
    const from = Math.max(0, index - PREFETCH_BEHIND);
    const to = Math.min(steps.length - 1, index + PREFETCH_AHEAD);
    for (let i = from; i <= to; i++) {
      const step = steps[i];
      if (!step || asked.current.has(step.id)) continue;
      asked.current.add(step.id);
      void getReplayFrame(token, workspaceId, sid, step.id).then((blob) => {
        if (sidRef.current !== sid) return; // 已经换了会话
        const url = blob ? URL.createObjectURL(blob) : null;
        if (url) made.current.add(url);
        setFrames((f) => ({ ...f, [step.id]: url }));
      });
    }
  }, [workspaceId, sid, steps, index]);

  const setIndex = useCallback(
    (i: number) => setIndexState(Math.max(0, Math.min(steps.length - 1, i))),
    [steps.length],
  );

  const cur = steps[index];
  const got = cur === undefined ? undefined : frames[cur.id];
  return {
    sessions,
    sid,
    steps,
    index,
    frame: got ?? null,
    missing: got === null,
    settled: (i) => {
      const s = steps[i];
      return s !== undefined && frames[s.id] !== undefined;
    },
    failed,
    selectSession: setSid,
    setIndex,
    reload: () => {
      before.current = { ids: steps.map((s) => s.id), index };
      setRound((n) => n + 1);
    },
  };
}
