// 附件图片的 blob URL：按相对 path 走 content 接口取，附件移除或组件卸载时回收。
// 返回 key → objectURL；key 由调用方给（草稿用附件 id，历史用 path），图片以外的项不取。
import { useEffect, useRef, useState } from "react";
import { attachmentBlob } from "../../../api/attachments";
import { loadToken } from "../../../api/http";
import { isInlineImageMime } from "../model/attachmentMime";

export interface PreviewItem {
  key: string;
  mimeType: string;
  path: string;
}

const isImage = (item: PreviewItem): boolean =>
  isInlineImageMime(item.mimeType);

export function useAttachmentSrcs(
  items: readonly PreviewItem[],
  sessionId: string,
): ReadonlyMap<string, string> {
  const [srcs, setSrcs] = useState<ReadonlyMap<string, string>>(new Map());
  const owned = useRef(new Map<string, string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const urls = owned.current;
    return () => {
      mounted.current = false;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  // 数组每次渲染都是新对象，用 key+path 签名当依赖：内容不变就不重复取。
  const signature = items.map((i) => `${i.key}\u0000${i.path}`).join("\u0001");

  // biome-ignore lint/correctness/useExhaustiveDependencies: items 的内容由 signature 表达
  useEffect(() => {
    const alive = new Set(items.filter(isImage).map((i) => i.key));
    for (const key of [...owned.current.keys()]) {
      if (alive.has(key)) continue;
      URL.revokeObjectURL(owned.current.get(key) ?? "");
      owned.current.delete(key);
      setSrcs((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    }
    for (const item of items) {
      if (!isImage(item) || item.path === "" || owned.current.has(item.key))
        continue;
      void attachmentBlob(loadToken(), sessionId, item.path).then((r) => {
        if (!r.ok || owned.current.has(item.key)) return;
        const url = URL.createObjectURL(r.data);
        if (!mounted.current) {
          URL.revokeObjectURL(url);
          return;
        }
        owned.current.set(item.key, url);
        setSrcs((prev) => new Map(prev).set(item.key, url));
      });
    }
  }, [signature, sessionId]);

  return srcs;
}
