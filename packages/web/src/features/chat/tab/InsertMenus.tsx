import type { RefObject } from "react";
import { Dot, IconButton, ListRow, Menu, Popover } from "../../../ui";
import { PlusIcon } from "../../../ui/icons";
import type { PickKind } from "../input/useFilePicker";
import { SLASH_GROUP_LABEL, SLASH_GROUPS, type SlashOption } from "./slash";

export interface InsertApi {
  /** 在光标处插入文本；back 是插入后光标要往回退几格（花括号内落光标用） */
  at(text: string, back?: number): void;
  /** 插入斜杠命令（替换开头已有的 /xxx） */
  command(name: string): void;
  pickFile(kind?: PickKind): void;
}

// 触屏（粗指针）设备才有拍照与相册：桌面浏览器的 capture 没有效果，别摆出来误导。
const coarse = (): boolean => window.matchMedia?.("(pointer: coarse)").matches;

// 附件（+）：上传文件 / 插入 @ 仓库引用 / 插入 {{@}} 隐私变量（光标落在花括号内）。
export function PlusMenu({ insert }: { insert: InsertApi }) {
  return (
    <Menu
      label="上传文件或插入引用"
      placement="top-start"
      items={[
        ...(coarse()
          ? [
              {
                id: "photo",
                label: "拍照",
                onSelect: () => insert.pickFile("photo"),
              },
              {
                id: "image",
                label: "相册",
                onSelect: () => insert.pickFile("image"),
              },
            ]
          : []),
        {
          id: "upload",
          label: "上传文件",
          hint: "任意格式",
          onSelect: () => insert.pickFile("any"),
        },
        {
          id: "path",
          label: "引用仓库文件",
          hint: "@",
          onSelect: () => insert.at("@"),
        },
        {
          id: "var",
          label: "引用隐私变量",
          hint: "{{@}}",
          onSelect: () => insert.at("{{@}}", 2),
        },
      ]}
      trigger={(p) => (
        <IconButton
          label="上传文件或插入引用"
          icon={<PlusIcon />}
          data-plus=""
          {...p}
        />
      )}
    />
  );
}

// 斜杠菜单：分组显示命令 / 技能 / MCP；焦点留在 textarea，由 Composer 处理过滤和方向键 / Enter。
// MCP 行是只读提示（名称、工具数、失败原因），不进键盘选择；active 是「可选项」里的序号。
export function SlashMenu({
  options,
  open,
  active,
  anchorRef,
  onClose,
  onPick,
}: {
  options: readonly SlashOption[];
  open: boolean;
  active: number;
  anchorRef: RefObject<HTMLElement | null>;
  onClose(): void;
  onPick(option: SlashOption): void;
}) {
  let at = -1;
  return (
    <Popover
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      label="快捷命令与技能"
      placement="top-start"
      width={360}
      className="ch-slash"
    >
      {options.length === 0 ? (
        <div className="t-aux ch-slash-empty">没有匹配的命令</div>
      ) : (
        SLASH_GROUPS.map((g) => {
          const rows = options.filter((o) => o.group === g);
          if (rows.length === 0) return null;
          return (
            <div key={g} className="ch-slash-g">
              <div className="t-group ch-slash-h">{SLASH_GROUP_LABEL[g]}</div>
              {rows.map((o) => {
                const idx = o.run ? ++at : -1;
                return (
                  <ListRow
                    key={o.id}
                    size="compact"
                    lead={
                      o.ready === undefined ? undefined : (
                        <Dot size="sm" tone={o.ready ? "live" : "danger"} />
                      )
                    }
                    label={
                      <span
                        className={o.group === "mcp" ? "t-mono" : "t-plain"}
                      >
                        {o.label}
                      </span>
                    }
                    trail={
                      <span className="ch-slash-hint t-aux">{o.hint}</span>
                    }
                    current={idx === active}
                    data-slash-id={o.id}
                    {...(o.run ? {} : { "aria-disabled": true })}
                    onClick={o.run ? () => onPick(o) : undefined}
                  />
                );
              })}
            </div>
          );
        })
      )}
    </Popover>
  );
}
