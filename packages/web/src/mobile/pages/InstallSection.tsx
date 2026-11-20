import { Button } from "../../ui";
import type { useInstall } from "../pwa/install";

type Install = ReturnType<typeof useInstall>;

// 添加到主屏幕：浏览器给了安装提示就放一个按钮，否则给图文步骤；已经在独立窗口里就不出现。
// 明文访问下浏览器不给安装，设置页顶上那一句已经说明，这里不再出现。
export function InstallSection({ install }: { install: Install }) {
  if (install.standalone) return null;
  return (
    <div className="m-block">
      {install.canPrompt ? (
        <>
          <p className="m-line t-aux">
            装成独立应用后，从主屏幕直接打开，没有地址栏。
          </p>
          <Button variant="outline" onClick={() => void install.prompt()}>
            添加到主屏幕
          </Button>
        </>
      ) : (
        <p className="m-line t-aux">
          {install.ios
            ? "点 Safari 底部的分享按钮，选「添加到主屏幕」。"
            : "点浏览器的菜单，选「添加到主屏幕」或「安装应用」。"}
        </p>
      )}
    </div>
  );
}
