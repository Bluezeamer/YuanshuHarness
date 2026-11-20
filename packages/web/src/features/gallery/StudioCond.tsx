import { useRef, useState } from "react";
import { Button, Checkbox, Popover, Segmented, Select } from "../../ui";
import { ChevronDownIcon } from "../../ui/icons";
import { type Cond, condText, emptyCond, PROVIDERS } from "./studioData";

const KINDS = [{ value: "model", label: "模型", hint: "供应商与模型" }];

// 一条条件的按钮：显示摘要，点开改。条件现在只有「模型」一种，下拉的位置留给以后的别的条件。
export function CondButton({
  when,
  prefix,
  onChange,
}: {
  when: Cond | null;
  prefix: string;
  onChange: (next: Cond | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const text = when ? condText(when) : "";
  const empty = when !== null && text === "";
  return (
    <>
      <Button
        ref={anchor}
        size="sm"
        variant="outline"
        className="gl-cond"
        data-empty={empty || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${prefix}的条件`}
        onClick={() => setOpen(!open)}
      >
        <span className="gl-cond-t">
          {when === null ? "其余情况" : empty ? "选择模型…" : `模型：${text}`}
        </span>
        <ChevronDownIcon />
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        label="编辑条件"
        placement="bottom-start"
        width={320}
        className="gl-condpop"
      >
        <CondEditor when={when} onChange={onChange} />
      </Popover>
    </>
  );
}

function CondEditor({
  when,
  onChange,
}: {
  when: Cond | null;
  onChange: (next: Cond | null) => void;
}) {
  const c = when ?? emptyCond();
  const set = (patch: Partial<Cond>) => onChange({ ...c, ...patch });
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  return (
    <div className="gl-ce">
      <Segmented
        size="sm"
        aria-label="条件方式"
        options={[
          { value: "if", label: "按条件" },
          { value: "else", label: "其余情况" },
        ]}
        value={when === null ? "else" : "if"}
        onChange={(v) => onChange(v === "else" ? null : emptyCond())}
      />
      {when === null ? (
        <div className="t-aux">
          前面的条件都不成立时用这一张。一个分组里放一张就够了，放在最后。
        </div>
      ) : (
        <>
          <Select
            aria-label="条件类型"
            value={c.kind}
            onChange={() => {}}
            options={KINDS}
          />
          <div className="t-aux">
            目前只有「模型」这一种条件，以后别的条件加在上面的下拉里。勾整个供应商
            = 它下面全部模型，包括以后新增的。
          </div>
          <div className="gl-ce-list">
            {PROVIDERS.map((p) => {
              const whole = c.providers.includes(p.id);
              const some = p.models.some((m) =>
                c.models.includes(`${p.id}/${m}`),
              );
              return (
                <div key={p.id}>
                  <Checkbox
                    checked={whole ? true : some ? "mixed" : false}
                    onChange={() =>
                      set({
                        providers: toggle(c.providers, p.id),
                        models: c.models.filter(
                          (k) => !k.startsWith(`${p.id}/`),
                        ),
                      })
                    }
                  >
                    {p.name}（全部）
                  </Checkbox>
                  <div className="gl-ce-sub">
                    {p.models.map((m) => {
                      const key = `${p.id}/${m}`;
                      return (
                        <Checkbox
                          key={key}
                          checked={whole || c.models.includes(key)}
                          disabled={whole}
                          onChange={() =>
                            set({ models: toggle(c.models, key) })
                          }
                        >
                          <span className="t-mono">{m}</span>
                        </Checkbox>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
