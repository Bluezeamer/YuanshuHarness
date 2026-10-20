import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AppView, parseAppLink } from "./appview";
import { Gate } from "./Gate";
import { registerServiceWorker } from "./pwa";
import { Shell } from "./Shell";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("缺少 #root");

const subscribeHash = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

// #/app/<类型> 是无 chrome 的「链接应用」视图，其余走完整外壳；两者共用同一道令牌门。
function Root() {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  const link = parseAppLink(hash);
  return (
    <Gate>
      {(sessions, onUnauthorized) =>
        link ? (
          <AppView
            link={link}
            sessions={sessions}
            onUnauthorized={onUnauthorized}
          />
        ) : (
          <Shell sessions={sessions} onUnauthorized={onUnauthorized} />
        )
      }
    </Gate>
  );
}

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

registerServiceWorker();
