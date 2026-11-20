import type { DefaultModel } from "../../../api/defaultModel";
import { TIER_HINT, TIER_LABEL, TIERS } from "../../../api/defaults";
import type { ProviderView } from "../../../api/providers";
import { InlineNotice, Segmented, Select, SettingRow } from "../../../ui";
import type { TabProps } from "./fields";
import { LEVEL_CN, levelOptions, settle } from "./model";

type Role = "model" | "review" | "aux";

const ROLES: ReadonlyArray<{
  key: Role;
  name: string;
  desc: string;
  optional: boolean;
}> = [
  {
    key: "model",
    name: "默认模型",
    desc: "agent 与会话都没指定模型时用",
    optional: false,
  },
  {
    key: "review",
    name: "审批模型",
    desc: "「模型」档下替你把关：它放行就直接执行，拿不准才问你",
    optional: true,
  },
  {
    key: "aux",
    name: "辅助模型",
    desc: "一次性小调用用，如团队公告板摘要，建议选便宜的；不配就用会话自己的模型",
    optional: true,
  },
];

function RoleRow({
  role,
  value,
  providers,
  onChange,
}: {
  role: (typeof ROLES)[number];
  value: DefaultModel | null;
  providers: readonly ProviderView[];
  onChange: (next: DefaultModel | null) => void;
}) {
  const prov = providers.find((p) => p.id === value?.provider);
  const spec = prov?.models.find((m) => m.id === value?.model);
  const name = (what: string) => `${role.name} ${what}`;
  return (
    <div className="st-def-role">
      <div className="st-def-role-h">
        <span className="t-entry">{role.name}</span>
        <span className="t-aux">{role.desc}</span>
      </div>
      <div className="st-def-sels">
        <Select
          aria-label={name("供应商")}
          value={prov?.id ?? ""}
          placeholder="未设置"
          options={[
            ...(role.optional ? [{ value: "", label: "未设置" }] : []),
            ...providers.map((p) => ({ value: p.id, label: p.name })),
          ]}
          onChange={(v) =>
            onChange(
              v === ""
                ? null
                : settle(providers, v, {
                    thinking: value?.thinking ?? null,
                    fresh: true,
                  }),
            )
          }
        />
        <Select
          aria-label={name("模型")}
          value={spec?.id ?? ""}
          disabled={!prov}
          placeholder="—"
          options={(prov?.models ?? []).map((m) => ({
            value: m.id,
            label: m.name,
          }))}
          onChange={(v) =>
            prov &&
            onChange(
              settle(providers, prov.id, {
                model: v,
                thinking: value?.thinking ?? null,
                fresh: true,
              }),
            )
          }
        />
        <Select
          aria-label={name("思考级别")}
          value={value?.thinking ?? "off"}
          disabled={!prov || !value}
          options={levelOptions(spec).map((l) => ({
            value: l,
            label: `${LEVEL_CN[l]} · ${l}`,
          }))}
          onChange={(v) =>
            prov &&
            value &&
            onChange(
              settle(providers, prov.id, {
                model: value.model,
                thinking: v as DefaultModel["thinking"],
              }),
            )
          }
        />
      </div>
    </div>
  );
}

/** 模型与权限：三个模型角色一张表（每个角色一行），默认权限档与审批模型联动。 */
export function ModelsTab({
  form,
  set,
  providers,
}: TabProps & { providers: readonly ProviderView[] }) {
  const usable = providers.filter((p) => p.models.length > 0);
  const setRole = (key: Role, next: DefaultModel | null) =>
    set({
      [key]: next,
      // 审批模型被清掉时，停在「模型」档的默认档位退回「规则」，不留一个选着却用不了的档
      ...(key === "review" && next === null && form.tier === "auto"
        ? { tier: "rules" as const }
        : {}),
    });
  return (
    <>
      <section className="st-block" aria-label="模型">
        <header className="st-block-h t-group">模型</header>
        {usable.length === 0 ? (
          <InlineNotice tone="warn">
            还没有可选的模型：先到「供应商与模型」里添加。
          </InlineNotice>
        ) : (
          ROLES.map((r) => (
            <RoleRow
              key={r.key}
              role={r}
              value={form[r.key]}
              providers={usable}
              onChange={(next) => setRole(r.key, next)}
            />
          ))
        )}
      </section>

      <section className="st-block" aria-label="权限">
        <header className="st-block-h t-group">权限</header>
        <SettingRow
          label="默认权限档"
          description={
            <>
              {TIER_HINT[form.tier]}。会话里可以单独改，也可以随时恢复跟随。
              {form.review === null && "「模型」档要先配审批模型。"}
            </>
          }
        >
          <Segmented
            aria-label="默认权限档"
            options={TIERS.map((t) => ({
              value: t,
              label: TIER_LABEL[t],
              disabled: t === "auto" && form.review === null,
            }))}
            value={form.tier}
            onChange={(tier) => set({ tier })}
          />
        </SettingRow>
      </section>
    </>
  );
}
