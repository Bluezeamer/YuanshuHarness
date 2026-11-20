// 休眠页的缩略图：接口要带令牌，所以取成 Blob 再变成 object URL；换页面或不再休眠时释放。
import { useEffect, useState } from "react";
import { getThumb, type PageView } from "../../../../api/browser";
import { loadToken } from "../../../../api/http";

export function useThumb(
  workspaceId: string | null,
  page: PageView | null,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const pageId = page?.state === "sleeping" && page.hasThumb ? page.id : null;

  useEffect(() => {
    if (workspaceId === null || pageId === null) return;
    let alive = true;
    let made: string | null = null;
    void getThumb(loadToken(), workspaceId, pageId).then((blob) => {
      if (!alive || !blob) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    });
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [workspaceId, pageId]);

  return pageId === null ? null : url;
}
