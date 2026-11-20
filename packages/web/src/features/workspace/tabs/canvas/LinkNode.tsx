// 网页链接卡片：封面、标题、摘要、站点；信息由 Server 抓（canvas/link.ts），抓不到就只显示地址。双击在新标签页打开。
import type { NodeProps } from "@xyflow/react";
import { memo, useEffect, useState } from "react";
import { type LinkMeta, readLinkMeta } from "../../../../api/canvas";
import { loadToken } from "../../../../api/http";
import { type FlowNode, hostOf } from "./model";
import { useNodeCtx } from "./nodeCtx";
import { Handles, NodeLabel, Resizer } from "./nodeParts";

// 同一个地址只取一次（多张卡片、切标签再回来都不重复请求）；失败的不留，下次再试
const metas = new Map<string, Promise<LinkMeta | null>>();

function loadMeta(env: string, url: string): Promise<LinkMeta | null> {
  const key = `${env}\0${url}`;
  let p = metas.get(key);
  if (!p) {
    p = readLinkMeta(loadToken(), env, url).then((r) => {
      if (!r.ok || r.data.failed) metas.delete(key);
      return r.ok ? r.data : null;
    });
    metas.set(key, p);
  }
  return p;
}

export const LinkNode = memo(function LinkNode({
  data,
  selected,
}: NodeProps<FlowNode>) {
  const { env } = useNodeCtx();
  const url = data.url ?? "";
  const [meta, setMeta] = useState<LinkMeta | null | undefined>(undefined);
  const [noCover, setNoCover] = useState(false);
  const [noIcon, setNoIcon] = useState(false);

  useEffect(() => {
    let live = true;
    setNoCover(false);
    setNoIcon(false);
    void loadMeta(env, url).then((m) => {
      if (live) setMeta(m);
    });
    return () => {
      live = false;
    };
  }, [env, url]);

  const host = hostOf(url);
  const got = meta && !meta.failed ? meta : null;

  return (
    <div className="cv-node cv-link" data-selected={selected || undefined}>
      <Resizer selected={selected} />
      <Handles />
      <NodeLabel>
        <span className="cv-labtext" title={url}>
          {url.replace(/^https?:\/\//i, "")}
        </span>
      </NodeLabel>
      <div className="cv-box">
        {got?.image && !noCover && (
          <img
            className="cv-linkcover"
            src={got.image}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            referrerPolicy="no-referrer"
            onError={() => setNoCover(true)}
          />
        )}
        <div className="cv-nbody cv-linkbody">
          <div className="cv-linktitle t-entry">{got?.title ?? url}</div>
          {got?.description && (
            <div className="cv-linkdesc t-aux">{got.description}</div>
          )}
          {meta === null || meta?.failed ? (
            <div className="cv-muted t-aux">没能取到页面信息，双击仍可打开</div>
          ) : (
            <div className="cv-linkfoot t-aux">
              {got?.icon && !noIcon && (
                <img
                  className="cv-linkicon"
                  src={got.icon}
                  alt=""
                  draggable={false}
                  referrerPolicy="no-referrer"
                  onError={() => setNoIcon(true)}
                />
              )}
              <span className="cv-labtext">{got?.site ?? host}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
