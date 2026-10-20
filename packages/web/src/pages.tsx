import type { ReactNode } from "react";
import type { SessionInfo } from "./api";
import { SessionDetail } from "./detail/SessionDetail";
import { Link } from "./router";
import type { SessionHub } from "./sessions/hub";

// 整页容器：盖在（保持挂载的）工作台上。能力集 / 内置预览的真实内容由后续里程碑填进 children；wide 给三栏的会话详情用。
function Page({
  title,
  back,
  wide,
  children,
}: {
  title: string;
  back?: boolean;
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="enter absolute inset-0 z-40 overflow-auto bg-bg"
    >
      <div
        className={`mx-auto flex flex-col gap-5 px-6 py-6 ${wide ? "max-w-[1600px]" : "max-w-[1000px]"}`}
      >
        {back && (
          <Link
            to="/"
            className="self-start text-xs font-semibold text-accent-deep hover:underline"
          >
            ← 返回工作区
          </Link>
        )}
        <h1 className="m-0 text-[26px] font-bold tracking-tight">{title}</h1>
        {children ?? (
          <p data-page-pending className="m-0 text-mute">
            待接入
          </p>
        )}
      </div>
    </section>
  );
}

export const CapabilitiesPage = () => <Page title="能力集" />;
export const PreviewPage = () => <Page title="内置预览" />;

export function SessionPage({
  id,
  sessions,
  hub,
}: {
  id: string;
  sessions: SessionInfo[];
  hub: SessionHub;
}) {
  const s = sessions.find((x) => x.id === id);
  return (
    <Page title={s ? (s.name ?? "未命名会话") : "会话不存在"} back wide={!!s}>
      {s ? (
        <SessionDetail hub={hub} session={s} />
      ) : (
        <p className="m-0 text-mute">没有 id 为 {id} 的会话</p>
      )}
    </Page>
  );
}

export const NotFoundPage = () => (
  <Page title="页面不存在" back>
    <p className="m-0 text-mute">地址不正确</p>
  </Page>
);
