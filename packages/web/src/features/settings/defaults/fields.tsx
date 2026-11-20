import type { ReactNode } from "react";
import { Input, SettingRow } from "../../../ui";
import type { DefaultsForm, Errors, FieldKey } from "./model";

/** 三个页签共用的入参：整页一份草稿，页签只管自己那几项的摆放。 */
export interface TabProps {
  form: DefaultsForm;
  set: (patch: Partial<DefaultsForm>) => void;
  errors: Errors;
}

type NumField = Exclude<FieldKey, "start">;

/** 一行整数设置：数字存成文字，校验提示在行内，保存时才转换。 */
export function NumRow({
  field,
  label,
  description,
  form,
  set,
  errors,
}: TabProps & { field: NumField; label: string; description?: ReactNode }) {
  return (
    <SettingRow label={label} description={description} error={errors[field]}>
      {(c) => (
        <Input
          {...c}
          mono
          inputMode="numeric"
          value={form[field]}
          onChange={(e) => set({ [field]: e.target.value })}
        />
      )}
    </SettingRow>
  );
}
