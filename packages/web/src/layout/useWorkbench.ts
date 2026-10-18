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
    if (!isDoc(raw)) return;
    revision.current = rev;
    dirty.current = false;
    readonly.current = raw.version > DOC_VERSION;
    // 高版本文档只读展示，原样不动，不做修复。
    const n = readonly.current ? { doc: raw, repaired: false } : normalize(raw);
    docRef.current = n.doc;
    setDoc(n.doc);
    setRepaired(n.repaired);
    setSave(readonly.current ? { kind: "readonly" } : { kind: "ok" });
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
    if (flushing.current) await flushing.current;
    if (!dirty.current) return;
    const sent = docRef.current;
    const p = putWorkbench(loadToken(), revision.current, sent);
    flushing.current = p.then(() => {});
    const r = await p;
    flushing.current = null;
    if (r.ok) {
      revision.current = r.revision;
      if (docRef.current === sent) dirty.current = false;
      setSave({ kind: "ok" });
    } else if (r.kind === "conflict") {
      setSave({ kind: "conflict", current: r.current });
    } else if (r.kind === "unauthorized") {
      denied.current();
    } else {
      setSave({ kind: "failed" });
    }
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
      if (!dirty.current || readonly.current || flushing.current) return;
      const sent = docRef.current;
      const p = putWorkbench(loadToken(), revision.current, sent, true).then(
        () => {
          flushing.current = null;
        },
      );
      flushing.current = p;
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
    if (isDoc(d) && d.version > DOC_VERSION) {
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
