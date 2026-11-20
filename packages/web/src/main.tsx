// tokens.css 引入 tailwind 并声明 @layer 顺序，必须是打包进来的第一份 CSS；
// 否则各 feature 的 @layer components 先出现，会排在 tailwind 的 base 之前而被 preflight 压掉。
import "./ui/tokens.css";
import "./ui/ui.css";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { loadToken } from "./api/http";
import { applyFontSize, loadFontSize } from "./app/fontSize";
import { Gate } from "./app/Gate";
import { registerServiceWorker } from "./app/pwa";
import { Shell } from "./app/shell";
import { registerAllTabs } from "./app/shell/register";
import { sweepStaleTabViews } from "./features/workspace";
import { sweepStaleFileDrafts } from "./features/workspace/tabs/preview";

const root = document.getElementById("root");
if (!root) throw new Error("缺少 #root");

// 界面字号要在首帧之前落到达根元素：交给组件里的 effect 会先按默认档画一帧，刷新时看得见闪一下。
applyFontSize(loadFontSize());

registerAllTabs();
sweepStaleFileDrafts();
sweepStaleTabViews();

// 组件对照页（/?gallery=create|settings|workbench）：静态页，不连服务端，不进主包
const GalleryPage = lazy(() => import("./features/gallery/GalleryPage"));

function Root() {
  if (new URLSearchParams(location.search).has("gallery"))
    return (
      <Suspense fallback={null}>
        <GalleryPage />
      </Suspense>
    );
  return (
    <Gate alt={{ label: "手机版", href: "/m/" }}>
      {(_sessions, onUnauthorized) => (
        <Shell token={loadToken()} onUnauthorized={onUnauthorized} />
      )}
    </Gate>
  );
}

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

registerServiceWorker();
