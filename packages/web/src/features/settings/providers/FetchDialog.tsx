import { useCallback, useEffect, useState } from "react";
import type { ModelSpec, ProviderView } from "../../../api/providers";
import {
  Button,
  Checkbox,
  Empty,
  InlineNotice,
  Modal,
  SearchBox,
} from "../../../ui";
import { SpinnerIcon } from "../../../ui/icons";
import { blankModel } from "./model";
import type { ProvidersStore } from "./store";

type Stage =
  | { k: "loading" }
  | { k: "error"; message: string }
  | { k: "list"; ids: string[]; specs: ReadonlyMap<string, ModelSpec> };

// 从端点获取：只读一次 GET /models，列出端点上有哪些模型 id；协议不能探测的内置供应商改列目录里的模型。
// 内置目录里有的 id 添加时带上目录规格；没有的只有名字（标「待补全」），上下文长度等事后点开补全。
// 勾出来点「添加」才进已添加的列表。
export function FetchDialog({
  p,
  store,
  onAdd,
  onClose,
}: {
  p: ProviderView;
  store: ProvidersStore;
  onAdd: (models: ModelSpec[]) => Promise<string | null>;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ k: "loading" });
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setStage({ k: "loading" });
    void Promise.all([
      p.probeable ? store.probe(p.id) : null,
      p.custom ? [] : store.catalog(p.id),
    ]).then(([probed, catalog]) => {
      if (probed && !probed.ok)
        return setStage({ k: "error", message: probed.message });
      setStage({
        k: "list",
        ids: probed ? probed.data : catalog.map((m) => m.id),
        specs: new Map(catalog.map((m) => [m.id, m])),
      });
    });
  }, [store, p.id, p.probeable, p.custom]);
  useEffect(load, [load]);

  const have = new Set(p.models.map((m) => m.id));
  const ids = stage.k === "list" ? stage.ids : [];
  const specs = stage.k === "list" ? stage.specs : new Map<string, ModelSpec>();
  const needle = q.trim().toLowerCase();
  const shown = ids.filter((id) => id.toLowerCase().includes(needle));
  const free = shown.filter((id) => !have.has(id));
  const allPicked = free.length > 0 && free.every((id) => picked.has(id));

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };

  const submit = async () => {
    setAdding(true);
    const err = await onAdd(
      [...picked].map((id) => specs.get(id) ?? blankModel(id, "probe")),
    );
    setAdding(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={p.probeable ? `${p.name} 端点上的模型` : `${p.name} 目录里的模型`}
      description={
        p.probeable
          ? "只读：仅取回端点上有哪些模型，不会改动已添加的模型"
          : "这个供应商不能探测端点，列的是内置目录里的模型"
      }
      size="sm"
      footer={
        stage.k === "list" && (
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              loading={adding}
              disabled={picked.size === 0}
              onClick={() => void submit()}
            >
              {picked.size > 0 ? `添加所选（${picked.size}）` : "添加所选"}
            </Button>
          </>
        )
      }
    >
      {stage.k === "loading" && (
        <p className="pv-wait t-aux" role="status">
          <SpinnerIcon className="u-spin" size={14} />
          正在向端点取模型列表…
        </p>
      )}
      {stage.k === "error" && (
        <>
          <InlineNotice tone="danger">{stage.message}</InlineNotice>
          <div className="pv-fetch-retry">
            <Button variant="outline" onClick={load}>
              重试
            </Button>
          </div>
        </>
      )}
      {stage.k === "list" && (
        <div className="pv-fetch">
          <SearchBox
            value={q}
            onChange={setQ}
            placeholder={`在 ${ids.length} 个模型中筛选`}
            aria-label="筛选端点上的模型"
          />
          <div className="pv-fetch-bar t-aux">
            <span>
              共 {ids.length} 个，其中 {ids.filter((i) => have.has(i)).length}{" "}
              个已添加
            </span>
            {free.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setPicked(
                    allPicked
                      ? new Set([...picked].filter((i) => !free.includes(i)))
                      : new Set([...picked, ...free]),
                  )
                }
              >
                {allPicked ? "取消全选" : "全选未添加的"}
              </Button>
            )}
          </div>
          <fieldset className="pv-fetch-list">
            <legend className="sr-only">端点上的模型</legend>
            {shown.map((id) => (
              <div key={id} className="pv-fetch-row">
                {have.has(id) ? (
                  <>
                    <span className="t-mono pv-fetch-id">{id}</span>
                    <span className="t-aux">已添加</span>
                  </>
                ) : (
                  <Checkbox
                    checked={picked.has(id)}
                    onChange={(on) => toggle(id, on)}
                  >
                    <span className="t-mono">{id}</span>
                  </Checkbox>
                )}
              </div>
            ))}
            {shown.length === 0 && (
              <Empty
                compact
                title={ids.length === 0 ? "没有可添加的模型" : "没有匹配的模型"}
              />
            )}
          </fieldset>
          {error && <InlineNotice tone="danger">{error}</InlineNotice>}
          {ids.some((id) => !specs.has(id)) && (
            <p className="t-aux">
              目录里有的模型会带上规格；其余添加后只有模型名，上下文长度和思考档位要在列表里点开补全。
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
