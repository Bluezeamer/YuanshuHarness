import { Fragment, type MouseEvent } from "react";
import { Link, navigate } from "../../../app/router";
import { Empty, IconButton } from "../../../ui";
import { BackIcon } from "../../../ui/icons";
import { LeaveGuardProvider, useLeaveGuard } from "./leave";
import type { SettingsRoute } from "./types";

export interface SettingsLayoutProps {
  routes: readonly SettingsRoute[];
  /** `/settings/<page>` 里的 page；缺省显示第一项。 */
  page?: string | undefined;
}

const plainClick = (e: MouseEvent) =>
  e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

// 设置壳：导航靠底色与主区分开，不画外框、顶栏与分隔线；「返回」在导航最上面。
// 页面留白 --st-gutter 在 frame.css 里定义（ys-ui-design 的 X04）。
function Frame({ routes, page }: SettingsLayoutProps) {
  const guard = useLeaveGuard();
  const current =
    page === undefined ? routes[0] : routes.find((r) => r.path === page);
  return (
    <div className="st-app">
      <nav className="st-nav" aria-label="设置分区">
        <div className="st-nav-h">
          <IconButton
            label="返回工作区"
            icon={<BackIcon />}
            onClick={() => guard(() => navigate("/"))}
          />
          <span className="t-entry">设置</span>
        </div>
        <ul>
          {routes.map((r) => (
            <li key={r.path}>
              <Link
                to={`/settings/${r.path}`}
                className="st-nav-item t-entry"
                aria-current={r.path === current?.path ? "page" : undefined}
                onClick={(e) => {
                  // 有未保存的修改时先问；修饰键点击（新标签页打开）不拦
                  if (!plainClick(e)) return;
                  e.preventDefault();
                  guard(() => navigate(`/settings/${r.path}`));
                }}
              >
                <r.icon size={15} />
                <span>{r.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main className="st-main">
        <h1 className="sr-only">{current?.label ?? "未找到"}</h1>
        {current ? (
          <Fragment key={current.path}>{current.element}</Fragment>
        ) : (
          <Empty
            title="没有这个设置页"
            description={`/settings/${page} 不在设置导航里，从左侧选一个分区。`}
          />
        )}
      </main>
    </div>
  );
}

export function SettingsLayout(props: SettingsLayoutProps) {
  return (
    <LeaveGuardProvider>
      <Frame {...props} />
    </LeaveGuardProvider>
  );
}
