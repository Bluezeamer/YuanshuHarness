import { useCallback, useEffect, useRef, useState } from "react";
import { getWorkbench, loadToken, putWorkbench } from "../api";
import { addPane, DOC_VERSION, defaultDoc, normalize } from "./doc";
import type { Registry } from "./registry";
import type { LayoutDoc } from "./types";

export const SAVE_DELAY_MS = 800;

export type SaveState =
  | { kind: "ok" }
  | { kind: "readonly" }
  | { kind: "failed" }
  | { kind: "conflict"; current: { revision: number; document: unknown } };

const isDoc = (d: unknown): d is LayoutDoc =>
  typeof d === "object" &&
  d !== null &&
  typeof (d as LayoutDoc).version === "number" &&
  Array.isArray((d as LayoutDoc).windows) &&
  typeof (d as LayoutDoc).panes === "object";

const isNewer = (d: unknown) =>
  typeof d === "object" &&
  d !== null &&
  typeof (d as { version?: unknown }).version === "number" &&
  (d as { version: number }).version > DOC_VERSION;

// 第一次使用时的默认布局：一个 window，里面一个还没绑定会话的 chat pane。
export function initialDoc(registry: Registry): LayoutDoc {
  const d = defaultDoc();
  const entry = registry.newEntry("chat");
  const w = d.windows[0];
  if (!entry || !w) return d;
  return addPane(d, w.id, "p-initial", entry);
}

export function useWorkbench(registry: Registry, onUnauthorized: () => void) {
  const [doc, setDoc] = useState(() => initialDoc(registry));
  const [save, setSave] = useState<SaveState>({ kind: "ok" });
  const [repaired, setRepaired] = useState(false);
  const docRef = useRef(doc);
  const revision = useRef(0);
  const dirty = useRef(false);
  const readonly = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushing = useRef<Promise<void> | null>(null);
  const denied = useRef(onUnauthorized);
  denied.current = onUnauthorized;

  const adopt = useCallback((raw: unknown, rev: number) => {
    // 高版本文档的形状我们不认识：只读，原样不动；能渲染就展示，否则保留当前界面。
    if (isNewer(raw)) {
      revision.current = rev;
      dirty.current = false;
      readonly.current = true;
      if (isDoc(raw)) {
        docRef.current = raw;
        setDoc(raw);
      }
      setRepaired(false);
      setSave({ kind: "readonly" });
      return;
    }
    if (!isDoc(raw)) return;
    revision.current = rev;
    dirty.current = false;
    readonly.current = false;
    const n = normalize(raw);
    docRef.current = n.doc;
    setDoc(n.doc);
    setRepaired(n.repaired);
    setSave({ kind: "ok" });
  }, []);

  useEffect(() => {
    let alive = true;
    void getWorkbench(loadToken()).then((r) => {
      if (!alive) return;
      if (!r.ok) {
        if (r.kind === "unauthorized") denied.current();
        return;
      }
      if (r.data.document === null) {
        revision.current = r.data.revision;
        return;
      }
      // 加载期间用户已经改过：保留本地，保存时由 409 走冲突流程。
      if (dirty.current) return;
      adopt(r.data.document, r.data.revision);
    });
    return () => {
      alive = false;
    };
  }, [adopt]);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (!dirty.current || readonly.current) return;
    // 多个等待者会同时醒来：循环重查，保证同一时刻只有一个请求在途。
    while (flushing.current) await flushing.current;
    if (!dirty.current || readonly.current) return;
    const sent = docRef.current;
    const run = async () => {
      try {
        const r = await putWorkbench(loadToken(), revision.current, sent);
        if (r.ok) {
          // revision 只升不降：pagehide 的响应可能与这里乱序到达。
          revision.current = Math.max(revision.current, r.revision);
          if (docRef.current === sent) dirty.current = false;
          setSave({ kind: "ok" });
        } else if (r.kind === "conflict") {
          setSave({ kind: "conflict", current: r.current });
        } else if (r.kind === "unauthorized") {
          denied.current();
        } else {
          setSave({ kind: "failed" });
        }
      } finally {
        // 无论回调是否抛错都要放行等待者，否则之后的保存会一直挂起。
        flushing.current = null;
      }
    };
    flushing.current = run();
    await flushing.current;
  }, []);

  const update = useCallback(
    (f: (d: LayoutDoc) => LayoutDoc) => {
      if (readonly.current) return;
      const next = f(docRef.current);
      if (next === docRef.current) return;
      docRef.current = next;
      dirty.current = true;
      setDoc(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  useEffect(() => {
    const onHide = () => {
      clearTimeout(timer.current);
      timer.current = undefined;
      if (!dirty.current || readonly.current) return;
      // 在途的非 keepalive 请求可能被页面卸载取消，所以仍要发最新文档。
      // 页面从 bfcache 恢复时要接上新 revision。
      // 已知限制：若在途请求先落地，这次会因 baseRevision 过期返回 409，最新改动不会保存；
      // 卸载中无法等待在途请求，所以只能尽力而为。
      const sent = docRef.current;
      void putWorkbench(loadToken(), revision.current, sent, true).then((r) => {
        if (!r.ok) return;
        revision.current = Math.max(revision.current, r.revision);
        if (docRef.current === sent) dirty.current = false;
      });
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      clearTimeout(timer.current);
    };
  }, []);

  // R21：采用服务器版本，丢弃本地未保存改动。
  const adoptServer = useCallback(() => {
    if (save.kind !== "conflict") return;
    const { document, revision: rev } = save.current;
    if (document === null) {
      revision.current = rev;
      dirty.current = false;
      setSave({ kind: "ok" });
      return;
    }
    adopt(document, rev);
  }, [save, adopt]);

  // R21：以本地覆盖，用新 revision 重新提交。R20 只允许覆盖同版本或更旧的文档。
  const keepLocal = useCallback(() => {
    if (save.kind !== "conflict") return;
    const d = save.current.document;
    if (isNewer(d)) {
      readonly.current = true;
      dirty.current = false;
      setSave({ kind: "readonly" });
      return;
    }
    revision.current = save.current.revision;
    dirty.current = true;
    setSave({ kind: "ok" });
    void flush();
  }, [save, flush]);

  return { doc, update, save, repaired, adoptServer, keepLocal, flush };
}
