// 选文件与粘贴：任意类型都上传；粘贴文件（截图、从系统复制文件）与「上传文件」走同一条链路，纯文本保持默认粘贴。
// 触屏设备另有「拍照」与「相册」两个入口（同一条上传链路，只是 input 的 accept / capture 不同）。
import { type ClipboardEvent, type ReactNode, useRef } from "react";
import type { AttachmentUploads } from "./useUploads";

/** any：任意文件；photo：直接拍一张；image：从相册选图 */
export type PickKind = "any" | "photo" | "image";

export function useFilePicker(uploads: AttachmentUploads): {
  pick(kind?: PickKind): void;
  onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void;
  /** 隐藏的文件框，要渲染在表单里 */
  input: ReactNode;
} {
  const refs: Record<PickKind, React.RefObject<HTMLInputElement | null>> = {
    any: useRef<HTMLInputElement>(null),
    photo: useRef<HTMLInputElement>(null),
    image: useRef<HTMLInputElement>(null),
  };
  const field = (kind: PickKind) => (
    <input
      key={kind}
      ref={refs[kind]}
      type="file"
      hidden
      data-file-input={kind === "any" ? "" : kind}
      {...(kind === "any" ? { multiple: true } : { accept: "image/*" })}
      {...(kind === "photo" ? { capture: "environment" as const } : {})}
      {...(kind === "image" ? { multiple: true } : {})}
      onChange={(e) => {
        const files = e.target.files;
        if (files && files.length > 0) uploads.add(Array.from(files));
        // 清空 input 让同一个文件能再次选中
        e.target.value = "";
      }}
    />
  );
  return {
    pick: (kind = "any") => refs[kind].current?.click(),
    onPaste(e) {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      uploads.add(files);
    },
    input: (
      <>
        {field("any")}
        {field("photo")}
        {field("image")}
      </>
    ),
  };
}
