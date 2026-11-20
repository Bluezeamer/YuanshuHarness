import { useEffect, useState } from "react";
import { closeSession } from "../../api/auth";
import { removeSelf, type Whoami, whoami } from "../../api/devices";
import { clearToken, loadToken } from "../../api/http";
import { ConfirmButton, toast } from "../../ui";
import { useNav } from "../nav/NavProvider";
import { useInstall } from "../pwa/install";
import { usePush } from "../pwa/usePush";
import { TopBar } from "../ui/TopBar";
import { InstallSection } from "./InstallSection";
import { NotificationsSection } from "./NotificationsSection";

// 手机设置页：这台手机是谁、怎么访问的、通知、添加到主屏幕、退出。
export function SettingsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const nav = useNav();
  const push = usePush();
  const install = useInstall();
  const [who, setWho] = useState<Whoami | null>(null);
  useEffect(() => {
    void whoami(loadToken()).then((r) => r.ok && setWho(r.data));
  }, []);

  const signOut = async () => {
    const token = loadToken();
    // 会话 Cookie 也能认证请求：不一起清掉，刷新一下又登回去了
    await closeSession(token);
    // 设备令牌：服务端删掉这台设备才算退出；没删成就留在原地，免得本地清了、服务端的设备却还有效
    if (who?.kind === "device") {
      const r = await removeSelf(token);
      if (!r.ok && r.kind !== "unauthorized")
        return toast("退出没有成功，请重试", { tone: "danger" });
    }
    clearToken();
    onSignedOut();
  };

  return (
    <div className="m-page">
      <TopBar title="设置" onBack={nav.back} />
      <div className="m-scroll">
        <section className="m-sec">
          <h2 className="m-sec-h t-group">这台设备</h2>
          <p className="m-line t-plain">
            {who?.kind === "device"
              ? who.device.name
              : who
                ? "全局令牌登录"
                : "…"}
          </p>
          <p className="m-line t-aux">
            {window.isSecureContext
              ? "HTTPS 访问"
              : "明文访问：没有后台通知，也不能安装成独立应用"}
          </p>
        </section>
        <section className="m-sec" aria-label="通知">
          <h2 className="m-sec-h t-group">通知</h2>
          <NotificationsSection push={push} />
        </section>
        {window.isSecureContext && (
          <section className="m-sec" aria-label="添加到主屏幕">
            <h2 className="m-sec-h t-group">添加到主屏幕</h2>
            <InstallSection install={install} />
          </section>
        )}
        <section className="m-sec">
          <ConfirmButton
            variant="outline"
            disabled={!who}
            armedLabel="再点一次确认退出"
            onConfirm={() => void signOut()}
          >
            {who?.kind === "device" ? "退出此设备" : "退出登录"}
          </ConfirmButton>
        </section>
      </div>
    </div>
  );
}
