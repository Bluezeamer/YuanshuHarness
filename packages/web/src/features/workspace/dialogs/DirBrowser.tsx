import { type RefObject, useEffect, useRef, useState } from "react";
import { loadToken } from "../../../api/http";
import { Button, Popover } from "../../../ui";
import { AlertIcon, BackIcon } from "../../../ui/icons";
import { browseDir, type DirView } from "./api";
import type { Host } from "./model/catalog";
import {
  baseName,
  crumbsOf,
  isAbsolute,
  normDir,
  parentOf,
  selfAndAncestors,
} from "./model/path";

// 文件管理器式目录浏览：点目录只逐层进入，底部一行才是「写入」。
// 输入框里打字时跟随到最深一层存在的目录；不存在就回落到最近的上级并提示，不静默改值。

interface Props {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  host: Host;
  /** 没有现成路径时从哪里开始：全局默认起点，所有主机同一个值 */
  start: string;
  /** 目录行里当前的目录值 */
  value: string;
  onChoose: (path: string) => void;
}

interface Shown {
  dir: string;
  /** undefined = 加载中；null = 读不了 */
  view: DirView | null | undefined;
}

function Browser({
  host,
  start,
  value,
  onChoose,
}: Omit<Props, "open" | "onClose" | "anchorRef">) {
  const cache = useRef(new Map<string, DirView | null>());
  const [shown, setShown] = useState<Shown>({ dir: "", view: undefined });
  const [missing, setMissing] = useState(false);

  const fetchDir = async (path?: string) => {
    const key = path ?? "";
    if (cache.current.has(key)) return cache.current.get(key) ?? null;
    const v = await browseDir(loadToken(), host, start, path);
    cache.current.set(key, v);
    return v;
  };

  const enter = async (path: string) => {
    setShown({ dir: path, view: undefined });
    const v = await fetchDir(path);
    setShown({ dir: v?.path ?? path, view: v });
  };

  // 值或主机变化：重新算出该显示哪一层（切主机时按新主机的文件系统重算）
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetchDir 只依赖 host、start（面板打开期间不变）与稳定的 ref
  useEffect(() => {
    let alive = true;
    (async () => {
      const typed = normDir(value);
      let found: DirView | null = null;
      let exact = false;
      if (isAbsolute(typed)) {
        for (const p of selfAndAncestors(typed)) {
          found = await fetchDir(p);
          if (found) {
            exact = p === typed;
            break;
          }
        }
      }
      if (!found) found = await fetchDir(undefined);
      if (!alive) return;
      setMissing(isAbsolute(typed) && !exact);
      setShown({ dir: found?.path ?? "/", view: found });
    })();
    return () => {
      alive = false;
    };
  }, [value, host.id]);

  const typed = normDir(value);
  const { dir, view } = shown;
  const same = typed === dir;
  return (
    <>
      <div className="ws-cr-pk-head">
        <span className="t-entry">选择目录</span>
        <span className="t-mono">{host.name}</span>
      </div>
      <nav className="ws-cr-crumbs" aria-label="目录层级">
        {crumbsOf(dir || "/").map((c, i) => (
          <span key={c.path} className="ws-cr-crumb-wrap">
            {i > 0 && <span className="ws-cr-crumb-sep t-aux">›</span>}
            <Button
              variant="ghost"
              className="ws-cr-crumb t-mono"
              aria-current={c.last ? "true" : undefined}
              onClick={() => enter(c.path)}
            >
              {c.label}
            </Button>
          </span>
        ))}
      </nav>
      {missing && typed !== dir && (
        <div className="ws-cr-warnbar" role="status">
          <AlertIcon aria-hidden />
          <span className="t-aux">{typed} 不存在，已显示最近的上级</span>
        </div>
      )}
      <div className="ws-cr-pk-list" role="listbox" aria-label="子目录">
        {dir !== "/" && (
          <Button
            variant="ghost"
            role="option"
            aria-selected={false}
            className="ws-cr-prow is-up"
            data-pick-up
            onClick={() => enter(view?.parent ?? parentOf(dir))}
          >
            <BackIcon aria-hidden />
            <span className="ws-cr-pr-main">
              <span className="t-entry">上一级</span>
              <span className="t-mono">{view?.parent ?? parentOf(dir)}</span>
            </span>
          </Button>
        )}
        {view === undefined && (
          <div className="ws-cr-pk-empty t-aux">正在读取…</div>
        )}
        {view === null && (
          <div className="ws-cr-pk-empty t-aux">无法读取此目录</div>
        )}
        {view && view.dirs.length === 0 && (
          <div className="ws-cr-pk-empty t-aux">此目录没有子目录</div>
        )}
        {view?.dirs.map((p) => (
          <Button
            key={p}
            variant="ghost"
            role="option"
            aria-selected={p === typed}
            data-pick-dir={p}
            className="ws-cr-prow is-dir"
            onClick={() => enter(p)}
          >
            <span className="ws-cr-pr-main">
              <span className="ws-cr-pr-name t-entry">{baseName(p)}</span>
            </span>
            {p === typed && <span className="ws-cr-pr-meta t-aux">已选</span>}
          </Button>
        ))}
      </div>
      <div className="ws-cr-pk-choose">
        <span className="ws-cr-cur t-mono" title={dir}>
          {dir}
        </span>
        <Button
          variant="primary"
          size="sm"
          disabled={same || view === undefined}
          onClick={() => onChoose(dir)}
        >
          {same ? "已是当前目录" : "选择此目录"}
        </Button>
      </div>
    </>
  );
}

export function DirBrowser({
  open,
  onClose,
  anchorRef,
  host,
  start,
  value,
  onChoose,
}: Props) {
  return (
    <Popover
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      label="选择目录"
      width={420}
      className="ws-cr-pick"
    >
      <Browser
        key={host.id}
        host={host}
        start={start}
        value={value}
        onChoose={onChoose}
      />
    </Popover>
  );
}
