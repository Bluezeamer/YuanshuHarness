import { useState } from "react";
import type { SkillCandidate } from "../../../../api/skillLibrary";
import {
  Button,
  Field,
  InlineNotice,
  Input,
  ListRow,
  Modal,
  Segmented,
  Select,
} from "../../../../ui";
import {
  type Hosts,
  inferInstall,
  SOURCE_FORMS,
  SOURCE_KINDS,
  type SourceKind,
} from "./model";
import type { SkillsStore } from "./store";

export interface SkillInstallModalProps {
  store: SkillsStore;
  hosts: Hosts;
  /** 装好后回调，参数是库里的技能名。 */
  onInstalled: (name: string) => void;
  onClose: () => void;
}

const isCandidates = (v: unknown): v is SkillCandidate[] =>
  Array.isArray(v) &&
  v.every(
    (c) =>
      typeof (c as SkillCandidate)?.path === "string" &&
      typeof (c as SkillCandidate)?.name === "string",
  );

// 安装弹窗：粘贴一个来源（仓库网址、owner/repo、npm 包名、本地路径…），服务端识别；名称与描述取自技能自带的 SKILL.md。
// 一个仓库里有多个技能时，服务端返回候选，选一个再提交。
export function SkillInstallModal({
  store,
  hosts,
  onInstalled,
  onClose,
}: SkillInstallModalProps) {
  const envIds = Object.keys(hosts);
  const [kind, setKind] = useState<SourceKind>("auto");
  const [spec, setSpec] = useState("");
  const [hostId, setHostId] = useState(envIds[0] ?? "");
  const [path, setPath] = useState("");
  const [candidates, setCandidates] = useState<SkillCandidate[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const inferred = inferInstall({
    kind,
    spec,
    hostId,
    path,
    ...(picked ? { subdir: picked } : {}),
  });
  const bad = inferred && !inferred.ok ? inferred.message : null;
  const needPick = candidates !== null && picked === null;

  // 改了来源，之前的候选就不作数了
  const editSpec = (v: string) => {
    setSpec(v);
    setCandidates(null);
    setPicked(null);
    setError(null);
  };

  const submit = async () => {
    if (!inferred?.ok || needPick) return;
    setBusy(true);
    const r = await store.install(inferred.source);
    setBusy(false);
    if (r.ok) {
      onInstalled(r.data.name);
      return;
    }
    const list = (r.body as { candidates?: unknown } | null)?.candidates;
    if (r.code === "ambiguous_skills" && isCandidates(list)) {
      setCandidates(list);
      setPicked(null);
      setError(null);
      return;
    }
    setError(r.message);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="安装技能"
      description="装进库，停在「待分发」；分发到环境是单独的一步。"
      dismissOnScrim={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!inferred?.ok || needPick}
            onClick={() => void submit()}
          >
            {candidates !== null ? "装这一个" : "装进库"}
          </Button>
        </>
      }
    >
      <div className="st-tl-form">
        <Field label="来源">
          <Segmented
            aria-label="来源类型"
            options={SOURCE_KINDS.map((k) => ({ value: k.id, label: k.label }))}
            value={kind}
            onChange={(k) => {
              setKind(k);
              setCandidates(null);
              setPicked(null);
              setError(null);
            }}
          />
        </Field>
        {kind === "observed" ? (
          <>
            <Field label="环境">
              {(c) => (
                <Select
                  {...c}
                  value={hostId}
                  options={envIds.map((id) => ({
                    value: id,
                    label: hosts[id] ?? id,
                  }))}
                  onChange={setHostId}
                />
              )}
            </Field>
            <Field
              label="技能目录"
              hint="原地登记，不复制；原件留在环境里"
              error={bad}
            >
              {(c) => (
                <Input
                  {...c}
                  mono
                  value={path}
                  placeholder="环境里技能目录的路径"
                  onChange={(e) => {
                    setPath(e.target.value);
                    setError(null);
                  }}
                />
              )}
            </Field>
          </>
        ) : (
          <Field label="来源地址" hint={SOURCE_FORMS} error={bad}>
            {(c) => (
              <Input
                {...c}
                mono
                value={spec}
                placeholder="github.com/owner/repo"
                onChange={(e) => editSpec(e.target.value)}
              />
            )}
          </Field>
        )}
        {candidates !== null && (
          <fieldset className="st-tl-cands">
            <legend className="t-aux">
              这个仓库里有 {candidates.length} 个技能，选一个装
            </legend>
            <ul>
              {candidates.map((c) => (
                <li key={c.path}>
                  <ListRow
                    label={c.name}
                    sub={c.description || c.path}
                    trail={<span className="t-mono t-aux">{c.path}</span>}
                    current={picked === c.path}
                    onClick={() => setPicked(c.path)}
                    data-cand={c.path}
                  />
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <dl className="st-tl-preview" aria-label="由来源推断">
          <div>
            <dt className="t-aux">来源</dt>
            <dd className="t-mono" data-testid="pv-source">
              {inferred?.ok ? inferred.label : "—"}
            </dd>
          </div>
          <div>
            <dt className="t-aux">版本</dt>
            <dd className="t-mono" data-testid="pv-version">
              {inferred?.ok ? (inferred.version ?? "不跟踪版本") : "—"}
            </dd>
          </div>
          <div>
            <dt className="t-aux">名称与描述</dt>
            <dd className="t-mono">取自 SKILL.md</dd>
          </div>
        </dl>
        <p className="st-tl-dim t-aux">
          名称与描述以技能自带的 SKILL.md 为准，这里不接受手填。
        </p>
        {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      </div>
    </Modal>
  );
}
