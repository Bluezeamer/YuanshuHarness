// 手机端入口（/m/）：与桌面（src/main.tsx）同一套令牌与样式，页面是手机自己的。
// tokens.css 要第一个进来（它引入 tailwind 并声明 @layer 顺序）。
import "../ui/tokens.css";
import "../ui/ui.css";
import "../app/shell/shell.css";
import "./mobile.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setTokenStorage } from "../api/http";
import { applyFontSize, loadFontSize } from "../app/fontSize";
import { MobileApp } from "./MobileApp";
import { createNav } from "./nav/nav";
import { captureInstallPrompt } from "./pwa/install";
import { registerMobileServiceWorker } from "./pwa/register";

const root = document.getElementById("root");
if (!root) throw new Error("缺少 #root");

// 装成独立应用后冷启动要还在：令牌放 localStorage（桌面按页签放 sessionStorage）
setTokenStorage(localStorage);
applyFontSize(loadFontSize());

// beforeinstallprompt 只发一次且来得早：先捕获，设置页再用
captureInstallPrompt();
const nav = createNav();
registerMobileServiceWorker(nav);

createRoot(root).render(
  <StrictMode>
    <MobileApp nav={nav} />
  </StrictMode>,
);
