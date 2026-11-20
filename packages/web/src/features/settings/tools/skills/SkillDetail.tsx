import { useEffect, useState } from "react";
import {
  type DistItem,
  type SkillFile,
  type SkillView,
  shortVersion,
} from "../../../../api/skillLibrary";
import {
  Button,
  Chip,
  Menu,
  type MenuItem,
  SettingRow,
  Switch,
} from "../../../../ui";
import { BlocksIcon } from "../../../../ui/icons";
import { DetailHead } from "../../frame/DetailHead";
import { FormColumn } from "../../frame/layout";
import { useBindDirty } from "../../frame/leave";
import { notify } from "../../frame/notify";
import { SaveBar } from "../../frame/SaveBar";
import { useDraft } from "../../frame/useDraft";
import { EnvRow } from "../common/parts";
import { fill, toggleEnabled, update } from "./actions";
import {
  DIST_TEXT,
  type Hosts,
  hostLabel,
  inSyncCount,
  isHome,
  isTracked,
  isUpdatable,
  originText,
  pushTargets,
  type StatusKey,
  scripts,
  statusOf,
} from "./model";
import type { SkillsStore } from "./store";

export const TONE: Record<StatusKey, "live" | "warn" | "idle"> = {
  busy: "warn",
  off: "idle",
  locked: "live",
  update: "warn",
  drift: "warn",
  pending: "idle",
  ok: "live",
};

// 环境行的状态：原件所在的环境算一致；探测不到的环境单独标出原因。
function envState(s: SkillView, d: DistItem) {
  if (isHome(s, d)) return { tone: "live", text: "原件所在" } as const;
  if (d.state === "missing" && d.error)
    return { tone: "danger", text: `探测不到：${d.error}` } as const;
  if (d.state === "behind")
    return {
      tone: "warn",
      text: `${DIST_TEXT.behind}（库里是 ${s.version === null ? "当前内容" : shortVersion(s.version)}）`,
    } as const;
  if (d.state === "missing")
    return { tone: "idle", text: DIST_TEXT.missing } as const;
  return { tone: "live", text: DIST_TEXT["in-sync"] } as const;
}

export interface SkillDetailProps {
  skill: SkillView;
  hosts: Hosts;
  store: SkillsStore;
  /** 正在跑的操作文案；有就置灰操作。 */
  busy: string | undefined;
  onFiles: () => void;
  onVersions: () => void;
  onRemove: () => void;
}

export function SkillDetail({
  skill: s,
  hosts,
  store,
  busy,
  onFiles,
  onVersions,
  onRemove,
}: SkillDetailProps) {
  const st = statusOf(s, busy ?? null);
  const o = originText(s.origin, hosts);
  const targets = pushTargets(s);
  const dist = s.dist ?? [];
  const [files, setFiles] = useState<SkillFile[] | null>(null);
  const d = useDraft<boolean>(s.scope === "global", async (draft) => {
    const r = await store.setScope(s.name, draft ? "global" : "project");
    return r.ok ? null : r.message;
  });
  useBindDirty({ dirty: d.dirty, save: d.save, discard: d.discard });

  // hash 变了说明内容换了（更新之后），要重取文件清单
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  useEffect(() => {
    let live = true;
    void store.files(s.name).then((r) => {
      if (live && r.ok) setFiles(r.data);
    });
    return () => {
      live = false;
    };
  }, [store, s.name, s.hash]);

  const run = async (job: Promise<string | null>, done: string) =>
    notify(await job, done);

  const menu: MenuItem[] = [
    { id: "files", label: "查看文件", onSelect: onFiles },
    ...(isTracked(s)
      ? [{ id: "pick", label: "选择版本", onSelect: onVersions }]
      : []),
    ...(isTracked(s) && s.lockedVersion !== null
      ? [
          {
            id: "unlock",
            label: "解除锁定",
            onSelect: () =>
              void run(
                store.unlock(s.name).then((r) => (r.ok ? null : r.message)),
                "已解除锁定",
              ),
          },
        ]
      : []),
    {
      id: "toggle",
      label: s.enabled ? "禁用" : "启用",
      separatorBefore: true,
      onSelect: () =>
        void run(toggleEnabled(store, s), s.enabled ? "已禁用" : "已启用"),
    },
    { id: "remove", label: "卸载", tone: "danger", onSelect: onRemove },
  ];

  const primary = isUpdatable(s) ? (
    <Button
      variant="primary"
      disabled={busy !== undefined}
      onClick={() => void run(update(store, s), `已更新到 ${s.latestVersion}`)}
    >
      更新到 {s.latestVersion}
    </Button>
  ) : s.enabled && targets.length > 0 ? (
    <Button
      variant="primary"
      disabled={busy !== undefined}
      onClick={() => void run(fill(store, hosts, s), "已补齐")}
    >
      补齐 {targets.length} 个环境
    </Button>
  ) : null;

  return (
    <>
      <FormColumn>
        <article aria-label={`${s.name} 详情`}>
          <DetailHead
            icon={<BlocksIcon size={18} />}
            title={s.name}
            sub={s.description}
            status={{ text: st.text, tone: TONE[st.key] }}
            actions={
              <>
                {primary}
                <Menu label="更多操作" items={menu} />
              </>
            }
          />

          <section className="st-block" aria-label="生效范围">
            <header className="st-block-h t-group">生效范围</header>
            <SettingRow
              label="对所有会话生效"
              description={
                d.draft
                  ? "镜像到各主机的全局技能目录，每个会话都带上，不用再勾选。"
                  : "只在勾选了它的工作区里生效（工作区设置 · 技能与 MCP），同步进该工作区目录的项目技能目录。"
              }
            >
              <Switch
                aria-label={`${s.name} 全局`}
                checked={d.draft}
                onChange={d.setDraft}
              />
            </SettingRow>
          </section>

          <section className="st-block" aria-label="来源与版本">
            <header className="st-block-h t-group">来源与版本</header>
            <SettingRow label="来源">
              <span className="tp-inline">
                <Chip>{o.kind}</Chip>
                <span className="t-mono">
                  {s.origin?.kind === "git" && s.origin.ref
                    ? `${o.name}@${s.origin.ref}`
                    : o.name}
                </span>
              </span>
            </SettingRow>
            <SettingRow
              label="版本"
              description={
                s.lockedVersion !== null
                  ? "已锁定：补齐与更新都停在这一版"
                  : s.version === null
                    ? "目录与环境纳入的技能不跟踪版本"
                    : undefined
              }
            >
              <span className="tp-inline">
                <span className="t-mono">
                  {s.version === null ? "不跟踪版本" : shortVersion(s.version)}
                </span>
                {s.lockedVersion !== null && <Chip>已锁定</Chip>}
                {s.latestVersion !== null && s.latestVersion !== s.version && (
                  <Chip {...(isUpdatable(s) ? { tone: "warn" as const } : {})}>
                    最新 {shortVersion(s.latestVersion)}
                  </Chip>
                )}
              </span>
            </SettingRow>
          </section>

          {s.scope === "global" ? (
            <section className="st-block" aria-label="分发">
              <header className="st-block-h t-group">
                <span>分发</span>
                <span className="t-mono">
                  {inSyncCount(s)}/{dist.length}
                </span>
              </header>
              <p className="tp-note t-aux">
                技能存放在 Server
                的库里。会话创建与切换目录时会把用到的技能补到所在环境，这里可以提前备好。
              </p>
              <ul className="tp-envs" aria-label="各环境的分发情况">
                {dist.map((d) => {
                  const e = envState(s, d);
                  const pushable = s.enabled && targets.includes(d);
                  return (
                    <EnvRow
                      key={d.hostId}
                      host={hostLabel(hosts, d.hostId)}
                      version={
                        d.version === null ? null : shortVersion(d.version)
                      }
                      tone={e.tone}
                      state={e.text}
                      {...(pushable
                        ? {
                            action: {
                              label: d.state === "behind" ? "补齐" : "分发",
                              disabled: busy !== undefined,
                              onClick: () =>
                                void run(
                                  fill(store, hosts, s, [d.hostId]),
                                  `已${d.state === "behind" ? "补齐" : "分发到"} ${hostLabel(hosts, d.hostId)}`,
                                ),
                            },
                          }
                        : {})}
                    />
                  );
                })}
              </ul>
            </section>
          ) : (
            <section className="st-block" aria-label="分发">
              <header className="st-block-h t-group">分发</header>
              <p className="tp-note t-aux">
                项目级技能不按环境分发：会话创建与切换目录时，同步进被勾选工作区的目录。打开上面的「对所有会话生效」后，才会镜像到各主机的全局技能目录。
              </p>
            </section>
          )}

          <section className="st-block" aria-label="内容">
            <header className="st-block-h t-group">
              <span>内容</span>
              {files && <span className="t-mono">{files.length} 个文件</span>}
              <span className="tp-grow" />
              <Button size="sm" variant="ghost" onClick={onFiles}>
                查看文件
              </Button>
            </header>
            {files && scripts(files).length > 0 && (
              <p className="tp-note t-aux">
                含脚本：{scripts(files).slice(0, 4).join("、")}
                {scripts(files).length > 4 ? " 等" : ""}
                。运行需要所在主机有对应的运行时，缺了由 agent
                在使用时按需处理。
              </p>
            )}
            {files && (
              <ul className="tp-files">
                {files.map((f) => (
                  <li key={f.path} className="t-mono">
                    {f.path}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </article>
      </FormColumn>
      <SaveBar
        dirty={d.dirty}
        saving={d.saving}
        onSave={() => void d.save()}
        onDiscard={d.discard}
      />
    </>
  );
}
