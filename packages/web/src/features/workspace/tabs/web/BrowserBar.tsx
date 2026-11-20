// 工具条：永远一行。观察态（agent 在用，你旁观）= 页面入口 + 只读地址 + 控制台 + 「手动操作」；
// 手动态（你接管，或你自己的页面）= 同一行换成后退 / 前进 / 刷新 + 可编辑地址 + 控制台 + 「交还 agent」。
import { type RefObject, useState } from "react";
import {
  Button,
  Dot,
  IconButton,
  Input,
  Menu,
  type MenuItem,
} from "../../../../ui";
import {
  BackIcon,
  ChevronDownIcon,
  ForwardIcon,
  GlobeIcon,
  HistoryIcon,
  KeyIcon,
  LockIcon,
  RefreshIcon,
  TerminalIcon,
} from "../../../../ui/icons";
import type { PageView, StreamSend } from "../../browser";
import { type Address, isSecure } from "./model";

export interface MainAction {
  label: string;
  busy: boolean;
  onClick(): void;
}

export interface BrowserBarProps {
  pageCount: number;
  pagesOpen: boolean;
  pagesButton: RefObject<HTMLButtonElement | null>;
  onTogglePages(): void;
  page: PageView | null;
  address: Address;
  /** 手动态：你在操作（接管了 agent 的页面，或你自己的页面） */
  manual: boolean;
  /** 此刻这个窗口真能输入：手动态 + 操作窗口 + 页面醒着 + 连接正常 */
  canOperate: boolean;
  nav: Pick<StreamSend, "nav" | "goto">;
  consoleOpen: boolean;
  onToggleConsole(): void;
  replayOpen: boolean;
  onToggleReplay(): void;
  /** 手动态才有：把这个站点当前的登录状态存下来 */
  saveLogin: { busy: boolean; onClick(): void } | null;
  main: MainAction | null;
  /** 有新页面可看：点了才切 */
  hint: { name: string; onClick(): void } | null;
}

export function BrowserBar(p: BrowserBarProps) {
  const { page, address, manual, canOperate } = p;
  const [draft, setDraft] = useState<string | null>(null);
  // 公网页面编辑时给完整地址（带协议头），服务 / 文件给 `主机名:端口` 这种短写法，都是服务端认得的输入。
  const shown =
    address.kind === "public" && manual ? (page?.url ?? "") : address.text;

  // 窄窗格里工具条上放不下的动作收进「…」（工具条上的对应按钮由 CSS 按窗格宽度藏起来）；菜单项与按钮同一套行为
  const more: MenuItem[] = [
    ...(p.hint
      ? [
          {
            id: "hint",
            label: `有新页面 · ${p.hint.name}`,
            onSelect: p.hint.onClick,
          },
        ]
      : []),
    ...(manual
      ? [
          {
            id: "back",
            label: "后退",
            disabled: !canOperate,
            onSelect: () => p.nav.nav("back"),
          },
          {
            id: "forward",
            label: "前进",
            disabled: !canOperate,
            onSelect: () => p.nav.nav("forward"),
          },
          {
            id: "reload",
            label: "刷新",
            disabled: !canOperate,
            onSelect: () => p.nav.nav("reload"),
          },
        ]
      : []),
    ...(p.saveLogin
      ? [
          {
            id: "login",
            label: "保存登录",
            disabled: p.saveLogin.busy,
            onSelect: p.saveLogin.onClick,
          },
        ]
      : []),
    {
      id: "replay",
      label: "回放",
      hint: p.replayOpen ? "已开" : undefined,
      onSelect: p.onToggleReplay,
    },
    {
      id: "console",
      label: "控制台",
      hint: p.consoleOpen ? "已开" : undefined,
      onSelect: p.onToggleConsole,
    },
  ];

  const submit = () => {
    const text = (draft ?? "").trim();
    setDraft(null);
    if (text !== "" && text !== shown) p.nav.goto(text);
  };

  return (
    <div className="ws-wb-bar">
      <Button
        ref={p.pagesButton}
        variant="ghost"
        size="sm"
        className="ws-wb-pages"
        aria-label={`页面 ${p.pageCount}`}
        title="页面列表"
        aria-expanded={p.pagesOpen}
        aria-haspopup="dialog"
        onClick={p.onTogglePages}
      >
        <span className="ws-wb-ptext">页面 </span>
        {p.pageCount}
        <ChevronDownIcon size={12} />
      </Button>

      {manual && (
        <>
          <IconButton
            size="sm"
            className="ws-wb-nav"
            label="后退"
            icon={<BackIcon size={13} />}
            disabled={!canOperate}
            onClick={() => p.nav.nav("back")}
          />
          <IconButton
            size="sm"
            className="ws-wb-nav"
            label="前进"
            icon={<ForwardIcon size={13} />}
            disabled={!canOperate}
            onClick={() => p.nav.nav("forward")}
          />
          <IconButton
            size="sm"
            className="ws-wb-nav"
            label="刷新"
            icon={<RefreshIcon size={13} />}
            disabled={!canOperate}
            onClick={() => p.nav.nav("reload")}
          />
        </>
      )}

      <div className="ws-wb-addr" aria-busy={page?.loading || undefined}>
        <span
          className="ws-wb-lock"
          data-secure={isSecure(page?.url ?? "") || undefined}
        >
          {isSecure(page?.url ?? "") ? (
            <LockIcon size={12} />
          ) : (
            <GlobeIcon size={12} />
          )}
        </span>
        <Input
          mono
          readOnly={!manual || !canOperate}
          value={draft ?? shown}
          aria-label="页面地址"
          placeholder={page ? "" : "还没有页面"}
          spellCheck={false}
          title={page?.url}
          onFocus={() => manual && canOperate && setDraft(shown)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") e.currentTarget.blur();
          }}
        />
        {page?.loading && <span className="ws-wb-loading t-aux">加载中…</span>}
        {!manual && page && page.title !== "" && (
          <span className="ws-wb-sub t-aux">{page.title}</span>
        )}
      </div>

      {p.hint && (
        <Button
          variant="ghost"
          size="sm"
          className="ws-wb-hint"
          title="agent 打开了新页面，点一下切过去"
          onClick={p.hint.onClick}
        >
          <Dot tone="accent" size="sm" />
          有新页面 · {p.hint.name}
        </Button>
      )}

      {p.saveLogin && (
        <Button
          variant="ghost"
          size="sm"
          className="ws-wb-login ws-wb-sec"
          aria-label="保存登录状态"
          title="保存这个站点当前的登录状态，agent 之后打开它不用再登录"
          icon={<KeyIcon size={13} />}
          loading={p.saveLogin.busy}
          onClick={p.saveLogin.onClick}
        >
          <span className="ws-wb-ctext">保存登录</span>
        </Button>
      )}

      <Button
        variant="ghost"
        size="sm"
        className="ws-wb-rp-btn ws-wb-sec"
        aria-label="回放"
        aria-pressed={p.replayOpen}
        title="按时间线回看 agent 的动作"
        icon={<HistoryIcon size={13} />}
        onClick={p.onToggleReplay}
      >
        <span className="ws-wb-ctext">回放</span>
      </Button>

      <Button
        variant="ghost"
        size="sm"
        className="ws-wb-con-btn ws-wb-sec"
        aria-label="控制台"
        aria-pressed={p.consoleOpen}
        icon={<TerminalIcon size={13} />}
        onClick={p.onToggleConsole}
      >
        <span className="ws-wb-ctext">控制台</span>
      </Button>

      <Menu items={more} label="更多操作" className="ws-wb-more" />

      {p.main && (
        <Button
          variant="primary"
          size="sm"
          loading={p.main.busy}
          onClick={p.main.onClick}
        >
          {p.main.label}
        </Button>
      )}
    </div>
  );
}
