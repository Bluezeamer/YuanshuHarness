import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSession,
  createWorkspace,
  listWorkspaces,
  loadToken,
  patchWorkspace,
  type Tier,
  type WorkspaceInfo,
} from "../api";
import { type DirChoice, DirPicker } from "./DirPicker";
import { actionBtn, describe, FULL_RISK, TIERS } from "./shared";

const tierLabel = (t: Tier) => TIERS.find((x) => x.id === t)?.label ?? t;

// 新建会话：选目录 → 选档位（仅未登记时）→ 登记（如需）→ 建会话。
export function NewSession({
  onCreated,
  onCancel,
  onUnauthorized,
}: {
  onCreated(): void;
  onCancel(): void;
  onUnauthorized(): void;
}) {
  const [list, setList] = useState<WorkspaceInfo[] | "loading" | "failed">(
    "loading",
  );
  const [picked, setPicked] = useState<DirChoice | null>(null);
  const [jump, setJump] = useState<{ path: string } | undefined>();
  const [tier, setTier] = useState<Tier>("rules");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void listWorkspaces(loadToken()).then((r) => {
      if (!live) return;
      if (!r.ok && r.kind === "unauthorized") onUnauthorized();
      setList(r.ok ? r.data : "failed");
    });
    return () => {
      live = false;
    };
  }, [onUnauthorized]);

  useEffect(() => {
    box.current?.focus();
  }, []);

  const onPick = useCallback((c: DirChoice | null) => setPicked(c), []);

  const known = Array.isArray(list) ? list : [];
  const existing = picked && known.find((w) => w.path === picked.path);
  const remember = (w: WorkspaceInfo) =>
    setList((cur) =>
      Array.isArray(cur) && !cur.some((x) => x.id === w.id) ? [...cur, w] : cur,
    );

  const fail = (
    r: Parameters<typeof describe>[0],
    ctx: Parameters<typeof describe>[1],
    prefix = "",
  ) => {
    if (r.kind === "unauthorized") onUnauthorized();
    setError(prefix + describe(r, ctx));
  };

  const create = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    const token = loadToken();
    let ws = existing || undefined;
    let fresh = false;
    if (!ws) {
      const r = await createWorkspace(token, { path: picked.path });
      if (r.ok) {
        ws = r.data;
        fresh = true;
        remember(ws);
      } else if (r.kind === "conflict") {
        // 他处已登记：按路径找到并复用，沿用其档位。
        const l = await listWorkspaces(token);
        ws = l.ok ? l.data.find((w) => w.path === picked.path) : undefined;
        if (ws) remember(ws);
        else {
          setBusy(false);
          setError("该目录已登记，但未能找到对应工作区，请刷新后重试");
          return;
        }
      } else {
        setBusy(false);
        fail(r, { bad_request: "目录不可用，请检查或换一个" });
        return;
      }
    }
    if (fresh && tier !== ws.tier) {
      const r = await patchWorkspace(token, ws.id, { tier });
      if (!r.ok) {
        setBusy(false);
        fail(
          r,
          { bad_request: "档位无效" },
          `目录已登记（当前为${tierLabel(ws.tier)}），但档位设置失败：`,
        );
        return;
      }
      remember(r.data);
    }
    const r = await createSession(token, { workspaceId: ws.id });
    setBusy(false);
    if (r.ok) {
      onCreated();
      return;
    }
    fail(
      r,
      { bad_request: "工作区目录不可用，请检查或换一个" },
      fresh ? "目录已登记，但创建会话失败：" : "创建会话失败：",
    );
  };

  const blocked = picked !== null && !picked.usable;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 仅用于捕获 Esc
    <div
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
      className="absolute inset-0 z-40 grid place-items-start justify-items-end bg-bg/60 p-4 backdrop-blur-[3px]"
    >
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="新建会话"
        className="enter flex max-h-full w-[min(520px,92vw)] flex-col overflow-y-auto outline-none gap-4 border border-ink bg-panel p-4"
      >
        <h2 className="m-0 text-base font-bold">新建会话</h2>
        {list === "failed" && (
          <p role="alert" className="m-0 font-semibold text-acc">
            已登记工作区加载失败，仍可直接选择目录
          </p>
        )}
        {known.length > 0 && (
          <section aria-label="已登记" className="flex flex-col gap-1">
            <h3 className="m-0 text-xs font-semibold">已登记</h3>
            <div className="flex flex-wrap gap-2">
              {known.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  title={w.path}
                  onClick={() => setJump({ path: w.path })}
                  className="border border-line px-2 py-0.5 text-xs font-semibold hover:bg-ink hover:text-bg"
                >
                  {w.name}
                </button>
              ))}
            </div>
          </section>
        )}
        <DirPicker
          jump={jump}
          onChange={onPick}
          onUnauthorized={onUnauthorized}
        />
        {picked && existing && (
          <p className="m-0 text-sm">
            该目录已登记，沿用档位：
            <span className="font-semibold">{tierLabel(existing.tier)}</span>
          </p>
        )}
        {picked && !existing && !blocked && (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 p-0 text-xs font-semibold">
              权限档位（登记此目录时生效）
            </legend>
            {TIERS.map((t) => (
              <label
                key={t.id}
                className={`grid cursor-pointer grid-cols-[auto_1fr] gap-x-3 border px-3 py-2 ${tier === t.id ? "border-ink" : "border-line"}`}
              >
                <input
                  type="radio"
                  name="new-tier"
                  value={t.id}
                  checked={tier === t.id}
                  onChange={() => setTier(t.id)}
                  className="mt-1"
                />
                <span className="font-semibold">{t.label}</span>
                <span className="col-start-2 text-xs text-mute">{t.hint}</span>
              </label>
            ))}
            {tier === "full" && (
              <p
                role="note"
                className="m-0 border border-acc px-3 py-2 text-sm font-semibold text-acc"
              >
                {FULL_RISK}
              </p>
            )}
          </fieldset>
        )}
        {blocked && (
          <p className="m-0 text-sm font-semibold text-acc">
            该目录不可读写，不能创建会话，请换一个目录
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 font-semibold text-acc">
            {error}
          </p>
        )}
        <div className="flex gap-3">
          <button
            type="button"
            disabled={busy || !picked || blocked}
            onClick={() => void create()}
            className={actionBtn}
          >
            创建
          </button>
          <button type="button" onClick={onCancel} className={actionBtn}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
