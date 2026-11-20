import { useState } from "react";
import type { ModelSpec, ProviderView } from "../../../api/providers";
import { Button, Chip, ListRow, Menu, SearchBox } from "../../../ui";
import { PlusIcon } from "../../../ui/icons";
import { act } from "./actions";
import { FetchDialog } from "./FetchDialog";
import { ModelDialog } from "./ModelDialog";
import { fetchBlock, fmtTokens, hasVision, needsFill } from "./model";
import type { ProvidersStore } from "./store";

const FOLD = 5;
const SEARCH_FROM = 8;

// 列表里一个模型只说三件事：名字、能做什么（思考 / 视觉）、能读多长。规格没填全的标「待补全」。
function ModelRow({
  m,
  onOpen,
  onRemove,
}: {
  m: ModelSpec;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <ListRow
      className="pv-model"
      label={m.name}
      title={m.name === m.id ? `编辑 ${m.name}` : `编辑 ${m.name}（${m.id}）`}
      trail={
        <span className="pv-model-trail">
          {m.reasoning && (
            <Chip title={`思考档位：${m.levels.join(" / ")}`}>思考</Chip>
          )}
          {hasVision(m) && <Chip>视觉</Chip>}
          {needsFill(m) ? (
            <Chip tone="warn">待补全</Chip>
          ) : (
            <span className="t-mono">{fmtTokens(m.ctx)} 上下文</span>
          )}
        </span>
      }
      actions={
        <Menu
          label={`${m.name} 的操作`}
          items={[
            { id: "edit", label: "编辑", onSelect: onOpen },
            {
              id: "remove",
              label: "移除",
              tone: "danger",
              separatorBefore: true,
              onSelect: onRemove,
            },
          ]}
        />
      }
      onClick={onOpen}
    />
  );
}

// 「已添加的模型」才会出现在新对话的模型选择里；「从端点获取」只是看端点上有什么，挑出来添加了才算。
// 内置供应商也一样：目录里的模型要从端点获取挑出来才算添加，添加后都可以移除。
export function ModelsSection({
  p,
  store,
}: {
  p: ProviderView;
  store: ProvidersStore;
}) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [fetching, setFetching] = useState(false);
  const [all, setAll] = useState(false);
  const [q, setQ] = useState("");
  const blocked = fetchBlock(p);

  const needle = q.trim().toLowerCase();
  const hit = p.models.filter(
    (m) =>
      !needle ||
      m.name.toLowerCase().includes(needle) ||
      m.id.toLowerCase().includes(needle),
  );
  const shown = needle || all ? hit : hit.slice(0, FOLD);
  const rest = hit.length - shown.length;

  // 保存一个模型：基于队列里最新的数据构造 payload，快速连改不会互相覆盖。
  // 弹窗自带提交：失败文案留在弹窗里，所以这两个返回文案而不是弹提示
  const save = async (spec: ModelSpec): Promise<string | null> => {
    const r = await store.update(p.id, (cur) => ({
      models: cur.models.some((x) => x.id === spec.id)
        ? cur.models.map((x) => (x.id === spec.id ? spec : x))
        : [...cur.models, spec],
    }));
    return r.ok ? null : r.message;
  };

  const add = async (models: ModelSpec[]): Promise<string | null> => {
    const r = await store.update(p.id, (cur) => ({
      models: [...cur.models, ...models],
    }));
    return r.ok ? null : r.message;
  };

  const remove = (m: ModelSpec) =>
    void act(
      store.update(p.id, (cur) => ({
        models: cur.models.filter((x) => x.id !== m.id),
      })),
      `已移除 ${m.name}`,
    );

  const target = editing && editing !== "new" ? editing : null;
  const spec = target ? p.models.find((m) => m.id === target) : undefined;

  return (
    <section className="st-block" aria-label="模型">
      <header className="st-block-h t-group">
        <span>模型</span>
        <span className="t-mono">{p.models.length}</span>
        <span className="pv-grow" />
        {p.models.length > SEARCH_FROM && (
          <SearchBox
            className="pv-model-search"
            value={q}
            onChange={setQ}
            placeholder="搜索模型"
            aria-label="搜索模型"
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={blocked !== null}
          title={blocked ?? undefined}
          onClick={() => setFetching(true)}
        >
          从端点获取
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<PlusIcon size={12} />}
          onClick={() => setEditing("new")}
        >
          手动添加
        </Button>
      </header>
      <p className="pv-note t-aux">
        已添加的模型，新对话里选得到。「从端点获取」挑出来添加了才算。
      </p>
      <div className="pv-models">
        {shown.map((m) => (
          <ModelRow
            key={m.id}
            m={m}
            onOpen={() => setEditing(m.id)}
            onRemove={() => remove(m)}
          />
        ))}
        {hit.length === 0 && (
          <div className="pv-model-none t-aux">
            {p.models.length === 0
              ? "还没有已添加的模型：点「从端点获取」挑选，或手动添加。"
              : "没有匹配的模型"}
          </div>
        )}
        {rest > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="pv-more"
            onClick={() => setAll(true)}
          >
            显示其余 {rest} 个
          </Button>
        )}
      </div>
      {fetching && (
        <FetchDialog
          p={p}
          store={store}
          onAdd={add}
          onClose={() => setFetching(false)}
        />
      )}
      {(editing === "new" || spec) && (
        <ModelDialog
          key={target ?? "new"}
          base={spec}
          taken={new Set(p.models.map((m) => m.id))}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
