import type { ReactNode } from "react";
import type { SessionInfo } from "./api";
import { Link } from "./router";

// 整页容器：盖在（保持挂载的）工作台上。能力集 / 内置预览 / 会话详情的真实内容由后续里程碑填进 children。
function Page({
  title,
  back,
  children,
}: {
  title: string;
  back?: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="enter absolute inset-0 z-40 overflow-auto bg-bg"
    >
      <div className="mx-auto flex max-w-[1000px] flex-col gap-5 px-6 py-6">
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
}: {
  id: string;
  sessions: SessionInfo[];
}) {
  const s = sessions.find((x) => x.id === id);
  return (
    <Page title={s ? (s.name ?? "未命名会话") : "会话不存在"} back>
      {s ? undefined : <p className="m-0 text-mute">没有 id 为 {id} 的会话</p>}
    </Page>
  );
}

export const NotFoundPage = () => (
  <Page title="页面不存在" back>
    <p className="m-0 text-mute">地址不正确</p>
  </Page>
);
