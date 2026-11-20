import type { ReviewPrompt } from "../../../api/reviewPrompt";
import { Button, Chip, Empty, Field, Loading, Textarea } from "../../../ui";
import { FormPane } from "../frame/layout";
import { useBindDirty } from "../frame/leave";
import { SaveBar } from "../frame/SaveBar";
import { useDraft } from "../frame/useDraft";
import { criteriaError, useReviewPrompt } from "./useReviewPrompt";

/**
 * 审核提示词：「模型」档下，规则外的动作先交审批模型判定；这里改它的「判别准则」。
 * 开头（角色与输出格式）与结尾（证据可信度、防注入）固定只读，改坏了会让所有审核退化成「问你」。
 */
export function ReviewPromptTab() {
  const { state, retry, save } = useReviewPrompt();
  if (state.phase === "loading") return <Loading>正在读取审核提示词…</Loading>;
  if (state.phase === "error")
    return (
      <Empty
        tone="danger"
        title="读取审核提示词失败"
        description={state.message}
        action={<Button onClick={retry}>重试</Button>}
      />
    );
  return <Ready saved={state.saved} save={save} />;
}

function Ready({
  saved,
  save,
}: {
  saved: ReviewPrompt;
  save: (draft: string, max: number) => Promise<string | null>;
}) {
  const d = useDraft(saved.criteria, (draft) => save(draft, saved.max));
  // 服务端存的是去掉首尾空白的文本：保存成功后草稿也收成同一个样子，保存条才会消失
  const saveDraft = async () => {
    const ok = await d.save();
    if (ok) d.setDraft((cur) => cur.trim());
    return ok;
  };
  useBindDirty({ dirty: d.dirty, save: saveDraft, discard: d.discard });
  const error = d.dirty ? criteriaError(d.draft, saved.max) : null;
  const isDefault = d.draft.trim() === saved.defaultCriteria.trim();

  return (
    <FormPane
      footer={
        <SaveBar
          dirty={d.dirty}
          saving={d.saving}
          onSave={() => void saveDraft()}
          onDiscard={d.discard}
        />
      }
    >
      <section className="st-block" aria-label="审核提示词">
        <header className="st-block-h t-group">
          <span>审核提示词</span>
          {saved.custom && <Chip tone="accent">已自定义</Chip>}
          <span className="sd-sp" />
          <Button
            size="sm"
            variant="ghost"
            disabled={isDefault}
            onClick={() => d.setDraft(saved.defaultCriteria)}
          >
            恢复默认
          </Button>
        </header>
        <p className="sd-lede t-aux">
          「模型」权限档下，规则外的动作先交审批模型判定；判别准则决定它怎么判：什么放行、什么拒绝、什么交给你。保存后下一次审核就生效。工作区可以在「编辑工作区」里对这一段追加或覆盖。审批模型在「设置
          · 默认值」里选。
        </p>
        <Field label="固定开头（只读）">
          <pre className="sd-pre t-code">{saved.head}</pre>
        </Field>
        <Field
          label="判别准则"
          hint={`${d.draft.trim().length} / ${saved.max}`}
          error={error}
        >
          {(c) => (
            <Textarea
              {...c}
              mono
              rows={10}
              value={d.draft}
              onChange={(e) => d.setDraft(e.target.value)}
            />
          )}
        </Field>
        <Field label="固定结尾（只读）">
          <pre className="sd-pre t-code">{saved.tail}</pre>
        </Field>
      </section>
    </FormPane>
  );
}
