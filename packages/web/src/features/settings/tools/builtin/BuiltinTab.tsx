import { useEffect, useState } from "react";
import type { Policy, ToolRow } from "../../../../api/toolRules";
import {
  Button,
  Chip,
  Empty,
  Loading,
  Menu,
  type MenuItem,
  SearchBox,
  Segmented,
  Table,
  Td,
  Th,
} from "../../../../ui";
import { ChevronDownIcon, ChevronRightIcon } from "../../../../ui/icons";
import { ListColumn } from "../../frame/layout";
import { useBindDirty } from "../../frame/leave";
import { SaveBar } from "../../frame/SaveBar";
import { useDraft } from "../../frame/useDraft";
import { useSnapshot } from "../common/hooks";
import {
  type Bulk,
  bulkSet,
  changed,
  flatRule,
  GROUP_NOTE,
  isModified,
  matchesQuery,
  type Rules,
  rulesOf,
  sectionsOf,
  type ToolSection,
} from "./model";
import type { ToolsStore } from "./store";

const POLICY_OPTIONS = [
  { value: "allow", label: "放行" },
  { value: "ask", label: "审批" },
] as const;

const WIDTHS = ["24%", "34%", "16%", "16%", "10%"];

type Axis = "inside" | "outside";
const AXIS_LABEL: Record<Axis, string> = {
  inside: "cwd 内",
  outside: "cwd 外",
};

function Row({
  tool: t,
  rules,
  onSet,
  onReset,
}: {
  tool: ToolRow;
  rules: Rules;
  onSet: (name: string, next: Rules[string]) => void;
  onReset: (name: string) => void;
}) {
  const rule = rules[t.name];
  const modified = isModified(t, rules);
  return (
    <tr>
      <Td>
        <div className="tp-nm">
          <span className="t-mono">{t.name}</span>
          {t.framework && t.group.key !== "framework" && <Chip>常驻</Chip>}
          {modified && <Chip tone="accent">已修改</Chip>}
        </div>
      </Td>
      <Td>
        <span className="t-aux">{t.description}</span>
      </Td>
      {rule && t.kind === "path" ? (
        (["inside", "outside"] as const).map((axis) => (
          <Td key={axis}>
            <Segmented
              size="sm"
              aria-label={`${t.name} ${AXIS_LABEL[axis]}`}
              options={POLICY_OPTIONS}
              value={rule[axis]}
              onChange={(p: Policy) => onSet(t.name, { ...rule, [axis]: p })}
            />
          </Td>
        ))
      ) : rule ? (
        <Td colSpan={2}>
          <Segmented
            size="sm"
            aria-label={`${t.name} 审批`}
            options={POLICY_OPTIONS}
            value={rule.inside}
            onChange={(p: Policy) => onSet(t.name, flatRule(p))}
          />
        </Td>
      ) : (
        <Td colSpan={2}>
          <span className="t-aux">{t.note}</span>
        </Td>
      )}
      <Td align="end">
        {modified && (
          <Menu
            label={`${t.name} 的操作`}
            items={[
              {
                id: "reset",
                label: "恢复出厂",
                onSelect: () => onReset(t.name),
              },
            ]}
          />
        )}
      </Td>
    </tr>
  );
}

function Section({
  section: s,
  open,
  toggleable,
  onToggle,
  rules,
  onChange,
}: {
  section: ToolSection;
  open: boolean;
  toggleable: boolean;
  onToggle: () => void;
  rules: Rules;
  onChange: (next: Rules) => void;
}) {
  const adjustable = s.tools.filter((t) => t.factory !== null);
  const hasPath = s.tools.some((t) => t.kind === "path");
  const bulk = (to: Bulk) => () => onChange(bulkSet(rules, adjustable, to));
  const menu: MenuItem[] = [
    {
      id: "allow",
      label: "全部放行",
      ...(hasPath ? { hint: "含 cwd 内外" } : {}),
      onSelect: bulk("allow"),
    },
    {
      id: "ask",
      label: "全部审批",
      ...(hasPath ? { hint: "含 cwd 内外" } : {}),
      onSelect: bulk("ask"),
    },
    {
      id: "factory",
      label: "全部恢复出厂",
      separatorBefore: true,
      onSelect: bulk("factory"),
    },
  ];
  return (
    <section className="st-block" aria-label={s.name}>
      <header className="st-block-h t-group">
        <span>{s.name}</span>
        <span className="t-mono">{s.tools.length}</span>
        <span className="tp-grow" />
        {toggleable && (
          <Button
            size="sm"
            variant="ghost"
            icon={
              <ChevronRightIcon
                className="st-chev"
                data-open={open || undefined}
                size={12}
              />
            }
            aria-expanded={open}
            onClick={onToggle}
          >
            {open ? "收起" : "展开"}
          </Button>
        )}
        {adjustable.length > 1 && (
          <Menu
            label={`${s.name} 的批量设置`}
            items={menu}
            trigger={(p) => (
              <Button
                {...p}
                size="sm"
                variant="outline"
                aria-label={`${s.name} 的批量设置`}
              >
                批量设置
                <ChevronDownIcon size={12} />
              </Button>
            )}
          />
        )}
      </header>
      <p className="tp-note t-aux">{GROUP_NOTE[s.key]}</p>
      {open && (
        <Table widths={WIDTHS} caption={s.name}>
          <thead>
            <tr>
              <Th>工具</Th>
              <Th>说明</Th>
              {hasPath ? (
                <>
                  <Th>{AXIS_LABEL.inside}</Th>
                  <Th>{AXIS_LABEL.outside}</Th>
                </>
              ) : (
                <Th colSpan={2}>审批</Th>
              )}
              <Th>
                <span className="sr-only">操作</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {s.tools.map((t) => (
              <Row
                key={t.name}
                tool={t}
                rules={rules}
                onSet={(name, next) => onChange({ ...rules, [name]: next })}
                onReset={(name) =>
                  onChange(
                    bulkSet(
                      rules,
                      s.tools.filter((x) => x.name === name),
                      "factory",
                    ),
                  )
                }
              />
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

function Ready({ tools, store }: { tools: ToolRow[]; store: ToolsStore }) {
  const [q, setQ] = useState("");
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const saved = rulesOf(tools);
  const d = useDraft(saved, async (draft) => {
    const r = await store.save(changed(draft, saved));
    return r.ok ? null : r.message;
  });
  useBindDirty({ dirty: d.dirty, save: d.save, discard: d.discard });

  const sections = sectionsOf(tools.filter((t) => matchesQuery(t, q)));
  const searching = q.trim() !== "";
  const toggle = (key: string) =>
    setUnfolded((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <ListColumn
      footer={
        <SaveBar
          dirty={d.dirty}
          saving={d.saving}
          onSave={() => void d.save()}
          onDiscard={d.discard}
        />
      }
    >
      <div className="tp-bar">
        <SearchBox
          aria-label="搜索工具"
          placeholder="搜索工具"
          className="tp-search"
          value={q}
          onChange={setQ}
        />
        <span className="t-aux">
          Server 注册的内置工具，共 {tools.length} 个。MCP
          服务的工具在「MCP」页签。
        </span>
      </div>
      {sections.map((s) => {
        // 框架工具几乎都是固定规则，默认折起；搜索时全部展开
        const folded = s.key === "framework" && !searching;
        return (
          <Section
            key={s.key}
            section={s}
            open={!folded || unfolded.has(s.key)}
            toggleable={folded || (s.key === "framework" && searching)}
            onToggle={() => toggle(s.key)}
            rules={d.draft}
            onChange={d.setDraft}
          />
        );
      })}
      {sections.length === 0 && (
        <Empty title="没有匹配的工具" description="换个搜索词试试。" />
      )}
    </ListColumn>
  );
}

// 内置工具页签：Server 注册的全部工具，按用途分组；规则进草稿，点保存才落库（X06）。
export function BuiltinTab({ store }: { store: ToolsStore }) {
  const state = useSnapshot(store);
  useEffect(() => {
    void store.load();
  }, [store]);
  if (state.phase === "loading") return <Loading>正在读取工具…</Loading>;
  if (state.phase === "error")
    return (
      <Empty
        tone="danger"
        title="读取工具失败"
        description={state.message}
        action={<Button onClick={() => void store.load()}>重试</Button>}
      />
    );
  return <Ready tools={state.tools} store={store} />;
}
