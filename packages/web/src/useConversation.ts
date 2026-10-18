import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  type ChatEntry,
  type Failure,
  listMessages,
  listSessions,
  loadToken,
} from "./api";
import { type ConvState, type Frame, initial, reduce } from "./conversation";
import { afterEarlier, afterTail, type Loaded, loadOlder } from "./history";
import { Stream, streamUrl } from "./stream";

export type Conn = "connecting" | "open" | "reconnecting" | "closed";

const RETRY_MS = 3000;
const MAX_FAILURES = 5;
const none: Loaded = { older: [], nextBefore: null };

type Action = { frame: Frame } | { reset: true };

export interface Conversation {
  state: ConvState;
  conn: Conn;
  older: ChatEntry[];
  hasEarlier: boolean;
  loadingEarlier: boolean;
  earlierFailed: boolean;
  historyLoading: boolean;
  historyFailed: boolean;
  notice: string | null;
  stopPending: boolean;
  send(text: string): boolean;
  stop(): void;
  reconnect(): void;
  loadEarlier(): void;
}

// 这两种探测结果说明继续握手没有意义，要停下来等人处理。
const stopReason = (f: Failure): string | null =>
  f.kind === "forbidden"
    ? "当前来源不被允许"
    : f.kind === "rate_limited"
      ? f.retryAfter
        ? `尝试过多，请 ${f.retryAfter} 秒后再试`
        : "尝试过多，请稍后再试"
      : null;

export function useConversation(
  sessionId: string,
  onSendFailed: (text: string) => void,
  onUnauthorized: () => void,
): Conversation {
  const [state, dispatch] = useReducer(
    (s: ConvState, a: Action) => ("reset" in a ? initial : reduce(s, a.frame)),
    initial,
  );
  const [conn, setConn] = useState<Conn>("connecting");
  const [loaded, setLoaded] = useState(none);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierFailed, setEarlierFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [stopPending, setStopPending] = useState(false);

  const stream = useRef<Stream | null>(null);
  const pending = useRef(new Map<string, "send" | "stop">());
  const lastSent = useRef(new Map<string, string>());
  const onRestore = useRef(onSendFailed);
  onRestore.current = onSendFailed;
  const onDenied = useRef(onUnauthorized);
  onDenied.current = onUnauthorized;
  const retryNow = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let failures = 0;
    let syncs = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Stream | null = null;

    dispatch({ reset: true });
    setConn("connecting");
    setLoaded(none);
    setHistoryLoading(false);
    setHistoryFailed(false);
    setLoadingEarlier(false);
    setEarlierFailed(false);
    setNotice(null);
    setStopPending(false);
    pending.current.clear();
    lastSent.current.clear();

    // 连接断开时没拿到回执的命令不会再有回执：发送的原文放回输入框，停止恢复可点。
    const settleCommands = () => {
      const unsent: string[] = [];
      for (const [id, kind] of pending.current) {
        const text = lastSent.current.get(id);
        if (kind === "send" && text !== undefined) unsent.push(text);
      }
      if (unsent.length) onRestore.current(unsent.join("\n"));
      pending.current.clear();
      lastSent.current.clear();
      setStopPending(false);
    };

    const sync = (startIndex: number) => {
      const run = ++syncs;
      setHistoryLoading(true);
      void loadOlder(
        () => listMessages(sessionId, loadToken()),
        startIndex,
      ).then((r) => {
        if (!alive || run !== syncs) return;
        setHistoryLoading(false);
        setHistoryFailed(!r.ok);
        setLoaded((prev) => (r.ok ? afterTail(prev, r) : none));
      });
    };

    const wait = () => {
      setConn("reconnecting");
      timer = setTimeout(() => void attempt(), RETRY_MS);
    };

    const fail = () => {
      failures += 1;
      if (failures >= MAX_FAILURES) setConn("closed");
      else wait();
    };

    // 每次重试先用 REST 探测：令牌失效时不能反复握手，那会计入限流。
    const attempt = async () => {
      timer = undefined;
      const r = await listSessions(loadToken());
      if (!alive) return;
      if (r.ok) return open();
      if (r.kind === "unauthorized") {
        setConn("closed");
        onDenied.current();
        return;
      }
      const reason = stopReason(r);
      if (reason) {
        setNotice(reason);
        setConn("closed");
        return;
      }
      fail();
    };

    const open = () => {
      let gotSnapshot = false;
      const s: Stream = new Stream(streamUrl(sessionId), loadToken(), {
        onFrame: (frame) => {
          if (!alive || current !== s) return;
          dispatch({ frame });
          if (frame.type === "snapshot") {
            failures = 0;
            if (!gotSnapshot) setNotice(null);
            gotSnapshot = true;
            setConn("open");
            const start = frame.data.startIndex;
            if (typeof start === "number" && start >= 0) sync(start);
            else {
              syncs += 1;
              setHistoryLoading(false);
              setHistoryFailed(true);
              setLoaded(none);
            }
          }
          if (frame.type === "run.ended") setStopPending(false);
        },
        onAck: (ack) => {
          if (!alive || !ack.id) return;
          const kind = pending.current.get(ack.id);
          const text = lastSent.current.get(ack.id);
          pending.current.delete(ack.id);
          lastSent.current.delete(ack.id);
          if (kind === "stop") setStopPending(false);
          if (ack.ok) return;
          setNotice(ack.error?.message ?? "命令失败");
          if (kind === "send" && text !== undefined) onRestore.current(text);
        },
        onClose: () => {
          if (!alive || current !== s) return;
          settleCommands();
          if (gotSnapshot) wait();
          else fail();
        },
        onProtocolError: (m) => {
          if (!alive || current !== s) return;
          settleCommands();
          setNotice(m);
          setConn("closed");
        },
      });
      current = s;
      stream.current = s;
    };

    retryNow.current = () => {
      if (!alive) return;
      clearTimeout(timer);
      failures = 0;
      setNotice(null);
      setConn("reconnecting");
      void attempt();
    };

    open();
    return () => {
      alive = false;
      clearTimeout(timer);
      settleCommands();
      current?.close();
      if (stream.current === current) stream.current = null;
    };
  }, [sessionId]);

  const send = useCallback((text: string) => {
    const body = text.trim();
    if (!body) return false;
    const id = stream.current?.command("send_message", { text: body });
    if (!id) return false;
    pending.current.set(id, "send");
    lastSent.current.set(id, text);
    setNotice(null);
    return true;
  }, []);

  const stop = useCallback(() => {
    const id = stream.current?.command("stop");
    if (!id) return;
    pending.current.set(id, "stop");
    setStopPending(true);
    setNotice(null);
  }, []);

  const reconnect = useCallback(() => retryNow.current(), []);

  const cursor = loaded.nextBefore;
  const loadEarlier = useCallback(() => {
    if (cursor === null || loadingEarlier) return;
    setLoadingEarlier(true);
    setEarlierFailed(false);
    void listMessages(sessionId, loadToken(), cursor).then((r) => {
      setLoadingEarlier(false);
      if (!r.ok) setEarlierFailed(true);
      else setLoaded((prev) => afterEarlier(prev, cursor, r.data));
    });
  }, [sessionId, cursor, loadingEarlier]);

  return {
    state,
    conn,
    older: loaded.older,
    hasEarlier: cursor !== null,
    loadingEarlier,
    earlierFailed,
    historyLoading,
    historyFailed,
    notice,
    stopPending,
    send,
    stop,
    reconnect,
    loadEarlier,
  };
}
