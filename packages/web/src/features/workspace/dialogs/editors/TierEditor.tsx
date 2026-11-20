import { type Tier, tierChoices } from "../../../../api/defaults";
import { Select } from "../../../../ui";
import type { Catalog } from "../model/catalog";

// 权限档位：第一项「跟随全局」（X02），选别的就是覆盖。
export function TierEditor({
  cat,
  value,
  onChange,
}: {
  cat: Catalog;
  value: Tier | null;
  onChange: (next: Tier | null) => void;
}) {
  return (
    <div className="dlg-stack">
      <Select
        aria-label="权限档位"
        value={value ?? ""}
        options={tierChoices(cat.globalTier, cat.hasReviewModel).map((t) => ({
          value: t.value ?? "",
          label: t.label,
          hint: t.hint,
          ...(t.disabled ? { disabled: true } : {}),
        }))}
        onChange={(v) => onChange(v === "" ? null : (v as Tier))}
      />
      <p className="t-aux">
        只管审批的松紧；哪些工具在哪能用，由能力和工具矩阵决定。
      </p>
    </div>
  );
}
