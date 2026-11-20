import { useState } from "react";
import type {
  VarExpiry,
  VariableView,
  VarPolicy,
} from "../../../api/variables";
import {
  Button,
  Drill,
  Field,
  Input,
  Modal,
  Segmented,
  Select,
  SummaryRow,
  Textarea,
  toast,
} from "../../../ui";
import { ErrorLine } from "./actions";
import { ExpiryEditor } from "./ExpiryEditor";
import {
  DESC_ERROR,
  DESC_MAX,
  GROUP_ERROR,
  GROUP_MAX,
  groupNames,
  NAME_ERROR,
  NAME_RE,
  POLICIES,
  POLICY_HINT,
  POLICY_LABEL,
} from "./model";
import type { VariablesStore, WorkspaceBrief } from "./store";
import {
  draftError,
  emptyDraft,
  type ValueDraft,
  ValueField,
} from "./ValueField";
import { WorkspacePicker } from "./WorkspacePicker";

const NEW_GROUP = " new";
const NO_GROUP = " none";

type Page = "policy" | "expiry" | "ws" | null;

const expiryText = (e: VarExpiry) =>
  e.kind === "never"
    ? "永久有效"
    : e.kind === "days"
      ? `${e.days} 天后到期`
      : "到期时间已选";

export interface AddVariableDialogProps {
  store: VariablesStore;
  all: readonly VariableView[];
  workspaces: readonly WorkspaceBrief[];
  now: number;
  onClose: () => void;
  onAdded: (id: string) => void;
}

// 添加变量：必填的在上面；引用策略 / 有效期 / 启用于工作区折成摘要行，默认值直接写在行上，点进去是二级页。
export function AddVariableDialog({
  store,
  all,
  workspaces,
  now,
  onClose,
  onAdded,
}: AddVariableDialogProps) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [draft, setDraft] = useState<ValueDraft>(emptyDraft());
  const [group, setGroup] = useState(NO_GROUP);
  const [newGroup, setNewGroup] = useState("");
  const [policy, setPolicy] = useState<VarPolicy>("ask");
  const [expiry, setExpiry] = useState<VarExpiry>({ kind: "days", days: 30 });
  const [enabled, setEnabled] = useState<ReadonlySet<string>>(new Set());
  const [page, setPage] = useState<Page>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const groups = groupNames(all);
  const groupName =
    group === NEW_GROUP
      ? newGroup.trim() || null
      : group === NO_GROUP
        ? null
        : group;

  const submit = async () => {
    const n = name.trim();
    const bad =
      (!NAME_RE.test(n) && NAME_ERROR) ||
      (desc.trim() === "" && DESC_ERROR) ||
      draftError(draft) ||
      (group === NEW_GROUP && groupName === null && GROUP_ERROR) ||
      (expiry.kind === "at" &&
        Date.parse(expiry.at) <= now &&
        "到期时间要在将来。") ||
      null;
    if (bad) return setError(bad);
    setBusy(true);
    const r = await store.add({
      name: n,
      desc: desc.trim(),
      group: groupName,
      workspaces: [...enabled].sort(),
      kind: draft.kind,
      value:
        draft.kind === "file" ? (draft.file?.text ?? "") : draft.text.trim(),
      ...(draft.kind === "file" && draft.file
        ? { fileName: draft.file.name }
        : {}),
      policy,
      expiry,
    });
    setBusy(false);
    if (r.ok) {
      toast("已添加", { tone: "ok" });
      onAdded(r.data.id);
      onClose();
    } else setError(r.message);
  };

  const toggleWs = (id: string, on: boolean) =>
    setEnabled((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Modal
      open
      onClose={onClose}
      title="添加变量"
      description="命令里写 {{@名称}} 引用它；描述会进入上下文，值只留在服务端。"
      dismissOnScrim={false}
      footer={
        page === null ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => void submit()}
            >
              添加变量
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => setPage(null)}>
            完成
          </Button>
        )
      }
    >
      {page === "policy" && (
        <Drill title="引用策略" onBack={() => setPage(null)}>
          <Segmented
            size="sm"
            aria-label="引用策略"
            value={policy}
            onChange={setPolicy}
            options={POLICIES.map((p) => ({
              value: p,
              label: POLICY_LABEL[p],
            }))}
          />
          <p className="t-aux">{POLICY_HINT[policy]}</p>
        </Drill>
      )}
      {page === "expiry" && (
        <Drill title="有效期" onBack={() => setPage(null)}>
          <ExpiryEditor value={expiry} onChange={setExpiry} now={now} />
          <p className="t-aux">到期后引用会被拦下，换一个新值才能恢复。</p>
        </Drill>
      )}
      {page === "ws" && (
        <Drill title="启用于工作区" onBack={() => setPage(null)}>
          <p className="t-aux">
            勾上的工作区，里面所有会话都能引用它。不勾就先不启用，之后随时可以在变量详情或「编辑工作区」里开。
          </p>
          <WorkspacePicker
            workspaces={workspaces}
            on={enabled}
            onToggle={toggleWs}
          />
        </Drill>
      )}
      {page === null && (
        <div className="vr-form">
          <Field
            label="名称"
            hint="小写字母开头，可含数字和 _ . -，3–48 个字符"
          >
            {(c) => (
              <Input
                {...c}
                mono
                autoComplete="off"
                spellCheck={false}
                placeholder="hf_token"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="描述"
            hint="进入上下文：写「什么时候用」，不要写值、内网地址或密钥前缀。"
          >
            {(c) => (
              <Textarea
                {...c}
                rows={2}
                maxLength={DESC_MAX}
                placeholder="Hugging Face 访问令牌，下载 gated 模型权重。"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
              />
            )}
          </Field>
          <ValueField draft={draft} onChange={setDraft} />
          <Field
            label="变量组"
            hint="可不填。同组的变量能在「编辑工作区」里一起勾选。"
          >
            <div className="vr-stack">
              <Select
                aria-label="变量组"
                value={group}
                options={[
                  { value: NO_GROUP, label: "不分组" },
                  ...groups.map((g) => ({ value: g, label: g })),
                  { value: NEW_GROUP, label: "新建变量组…" },
                ]}
                onChange={setGroup}
              />
              {group === NEW_GROUP && (
                <Input
                  autoFocus
                  aria-label="新变量组名称"
                  placeholder="变量组名称，如 Git 权限"
                  maxLength={GROUP_MAX}
                  value={newGroup}
                  onChange={(e) => setNewGroup(e.target.value)}
                />
              )}
            </div>
          </Field>
          <div className="vr-sep" />
          <SummaryRow
            label="引用策略"
            value={POLICY_LABEL[policy]}
            note={policy === "ask" ? "默认" : undefined}
            onOpen={() => setPage("policy")}
          />
          <SummaryRow
            label="有效期"
            value={expiryText(expiry)}
            note={
              expiry.kind === "days" && expiry.days === 30 ? "默认" : undefined
            }
            onOpen={() => setPage("expiry")}
          />
          <SummaryRow
            label="启用于工作区"
            value={enabled.size === 0 ? "暂不启用" : `${enabled.size} 个工作区`}
            note={enabled.size === 0 ? "默认都不启用" : undefined}
            onOpen={() => setPage("ws")}
          />
          <ErrorLine error={error} />
        </div>
      )}
    </Modal>
  );
}
