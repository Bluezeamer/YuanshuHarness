import { useState } from "react";
import { Button, SettingRow, Switch } from "../../../ui";
import { NumRow, type TabProps } from "./fields";
import { UiFontSection } from "./UiFontSection";

const LIMITS = ["maxWidth", "maxHeight", "maxKiB", "jpegQuality"] as const;

/** 输入与显示：输入图片的自动压缩、灵感画布里图片与资源的处理、界面字号（后者是本机设置，不进保存条）。 */
export function InputTab(p: TabProps) {
  const { form, set, errors } = p;
  const [more, setMore] = useState(false);
  // 上限有填错的项时不能收起，免得错误藏在看不见的地方
  const open = more || LIMITS.some((k) => errors[k]);
  return (
    <>
      <section className="st-block" aria-label="图片压缩">
        <header className="st-block-h t-group">
          <span>输入图片压缩</span>
          <span className="st-def-grow" />
          {form.compress && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              onClick={() => setMore(!open)}
            >
              {open ? "收起上限" : "调整上限"}
            </Button>
          )}
        </header>
        <SettingRow
          label="自动压缩"
          description={
            form.compress
              ? `发送前压到 ${form.maxWidth}×${form.maxHeight} 像素、${form.maxKiB} KiB 以内，JPEG 质量 ${form.jpegQuality}`
              : "关闭后图片原样发送，不做尺寸与体积压缩"
          }
        >
          <Switch
            aria-label="自动压缩"
            checked={form.compress}
            onChange={(compress) => set({ compress })}
          />
        </SettingRow>
        {form.compress && open && (
          <>
            <NumRow
              {...p}
              field="maxWidth"
              label="最大宽度"
              description="像素，超出按比例缩小"
            />
            <NumRow
              {...p}
              field="maxHeight"
              label="最大高度"
              description="像素，超出按比例缩小"
            />
            <NumRow
              {...p}
              field="maxKiB"
              label="编码上限"
              description="KiB，压缩后 base64 的字节上限"
            />
            <NumRow
              {...p}
              field="jpegQuality"
              label="JPEG 质量"
              description="重编码成 JPEG 时的质量"
            />
          </>
        )}
      </section>

      <section className="st-block" aria-label="画布图片与资源">
        <header className="st-block-h t-group">
          <span>灵感画布的图片与资源</span>
        </header>
        <NumRow
          {...p}
          field="thumbSide"
          label="缩略图最长边"
          description="像素；画布里的图片按它缩小后再显示，越大越清楚、传得越慢"
        />
        <NumRow
          {...p}
          field="thumbQuality"
          label="缩略图质量"
          description="重编码成 JPEG 时的质量（PNG 不受影响）"
        />
        <NumRow
          {...p}
          field="gifMB"
          label="GIF 原样上限"
          description="MB；不超过它的 GIF 原样显示、会动，更大的只显示第一帧"
        />
        <NumRow
          {...p}
          field="sourceMB"
          label="原图上限"
          description="MB；图片原文件超过它就不在画布里显示"
        />
        <NumRow
          {...p}
          field="uploadMB"
          label="单个文件上限"
          description="MB；粘贴或拖进画布的单个文件超过它就拒绝"
        />
        <NumRow
          {...p}
          field="assetGitMB"
          label="进历史的资源上限"
          description="MB；粘贴进来的资源超过它就不进画布的 git 历史，删了找不回"
        />
      </section>

      <UiFontSection />
    </>
  );
}
