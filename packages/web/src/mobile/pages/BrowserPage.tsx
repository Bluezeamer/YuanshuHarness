import { useEffect, useRef, useState } from "react";
import { useBrowser, usePageStream } from "../../features/workspace/browser";
import { useCurrentWorkspace } from "../../features/workspace/library/LibraryProvider";
import type { Tab } from "../../features/workspace/model/types";
import { useThumb } from "../../features/workspace/tabs/web/useThumb";
import {
  Button,
  Chip,
  Dot,
  Empty,
  IconButton,
  ListRow,
  Loading,
  Sheet,
} from "../../ui";
import { GlobeIcon } from "../../ui/icons";
import { useViewer } from "../browser/useViewer";
import { useWakeLock } from "../browser/useWakeLock";
import { PAGE_H, PAGE_W } from "../browser/viewTransform";
import { useNav, useRoute } from "../nav/NavProvider";
import { TopBar } from "../ui/TopBar";

const usePageVisible = (): boolean => {
  const [visible, setVisible] = useState(
    () => document.visibilityState === "visible",
  );
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
};

// 浏览器画面（只读观察）：看 agent 在网页上做什么。画面固定 1280×800，默认适应宽度，双指缩放、单指平移；
// 画面上的点按不发给页面，要接管请到电脑上。流只在这一页开着、页面在前台时才连。
export function BrowserPage({ tab }: { tab: Tab }) {
  const nav = useNav();
  const route = useRoute();
  const workspaceId = useCurrentWorkspace().id;
  const { state } = useBrowser(workspaceId);
  const pages = state.pages;
  const page =
    pages.find((p) => p.id === tab.page) ??
    (tab.page === undefined ? (pages[0] ?? null) : null);
  const visible = usePageVisible();
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = visible && page?.state === "active";
  const stream = usePageStream(
    workspaceId ?? "",
    live ? page.id : null,
    canvas,
  );
  const thumb = useThumb(workspaceId, page);
  const viewer = useViewer(page?.id ?? "");
  useWakeLock(live);

  let overlay: React.ReactNode = null;
  if (workspaceId === null || state.engine === null)
    overlay = <Loading>连接浏览器…</Loading>;
  else if (page === null)
    overlay = (
      <Empty
        title={tab.page === undefined ? "还没有页面" : "这个页面已经关闭了"}
        description="agent 打开网页后会出现在这里。"
      />
    );
  else if (page.state === "sleeping")
    overlay = (
      <div className="m-view-note">
        {thumb && <img className="m-view-thumb" src={thumb} alt="" />}
        <p className="t-plain">页面在休眠，请在电脑上唤醒。</p>
      </div>
    );
  else if (stream.link === "closed")
    overlay = <Empty title="这个页面已经关闭了" />;
  else if (stream.link === "lost")
    overlay = (
      <Empty
        title="画面连接断开了"
        action={<Button onClick={stream.retry}>重试</Button>}
      />
    );
  else if (stream.link !== "live") overlay = <Loading>连接画面…</Loading>;

  const v = viewer.view;
  return (
    <div className="m-page m-browser">
      <TopBar
        title={page?.title || page?.url || "浏览器"}
        onBack={nav.back}
        end={
          <span className="m-badged">
            <IconButton
              label="页面列表"
              icon={<GlobeIcon />}
              onClick={() => nav.push({ name: "tab", tab, layer: "pages" })}
            />
          </span>
        }
      />
      <div className="m-view-bar">
        <Chip>只读观察</Chip>
        <span className="m-view-url t-mono">{page?.url ?? ""}</span>
      </div>
      {page?.handoffPending && (
        <p className="m-view-handoff t-plain">
          agent 请你接管页面
          {page.handoffReason ? `：${page.handoffReason}` : ""}
          。请到电脑上操作。
        </p>
      )}
      <div ref={viewer.ref} className="m-view" {...viewer.bind}>
        <canvas
          ref={canvas}
          role="img"
          aria-label="浏览器画面（只读）"
          className="m-view-canvas"
          width={PAGE_W}
          height={PAGE_H}
          style={{
            width: PAGE_W,
            height: PAGE_H,
            visibility:
              v && live && stream.link === "live" ? "visible" : "hidden",
            transform: v
              ? `translate(${v.x}px, ${v.y}px) scale(${v.scale})`
              : undefined,
          }}
        />
        {overlay && <div className="m-view-over">{overlay}</div>}
      </div>
      <div className="m-view-tools">
        <Button variant="outline" onClick={viewer.fit}>
          适应宽度
        </Button>
        <Button variant="outline" onClick={viewer.actual}>
          100%
        </Button>
      </div>
      {route.name === "tab" && route.layer === "pages" && (
        <Sheet title="页面" onClose={nav.back}>
          {pages.length === 0 && <p className="m-ws-none t-aux">还没有页面</p>}
          {pages.map((p) => (
            <ListRow
              key={p.id}
              className="m-row"
              label={p.title || p.url}
              sub={p.url}
              trail={
                p.inUseBy !== null ? (
                  <Dot tone="live" motion="pulse" label="agent 在用" />
                ) : p.state === "sleeping" ? (
                  <span className="t-aux">休眠</span>
                ) : null
              }
              onClick={() =>
                p.id === page?.id
                  ? nav.back()
                  : nav.replace({ name: "tab", tab: { ...tab, page: p.id } })
              }
            />
          ))}
        </Sheet>
      )}
    </div>
  );
}
