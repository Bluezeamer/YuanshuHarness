import { type CSSProperties, Fragment, type ReactNode } from "react";
import { Dot, HoverCard, ReadBar } from "../../../ui";
import { useHostTone } from "../../workspace/layoutContext";
import { fmtDuration, fmtTokens, type MetricsView } from "../model/metrics";
import type { WorkingPlace } from "./context";

const CARD_W = 216;

const dash = (v: string | null) => v ?? "—";

const Fact = ({ k, v }: { k: string; v: string }) => (
  <div className="u-hc-fact">
    <dt className="t-aux">{k}</dt>
    <dd className="t-aux">{v}</dd>
  </div>
);

const Card = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="ch-foot-card">
    <div className="t-group">{title}</div>
    <dl className="u-hc-facts">{children}</dl>
  </div>
);

// 词用辅助字，数字用等宽字（中英混排拆成两段）
const T = ({ k, v }: { k?: string; v: string }) => (
  <>
    {k && <span className="t-aux">{k}</span>}
    <span className="t-mono">{v}</span>
  </>
);

// agent 在哪台主机的目录里工作：只画主机色圆点（与窗格头的主机色同一套），主机名与完整路径在悬停卡片里。
function Place({ place }: { place: WorkingPlace }) {
  const tone = useHostTone(place.host);
  const style = tone
    ? ({ "--tone": `var(--h${tone})` } as CSSProperties)
    : undefined;
  return (
    <HoverCard
      width={CARD_W}
      card={
        <Card title="工作位置">
          <Fact k="主机" v={place.hostName} />
          <Fact k="目录" v={place.path} />
        </Card>
      }
    >
      <span className="ch-foot-i" data-foot="place">
        <Dot
          className="ch-foot-dot"
          style={style}
          label={`工作位置：${place.hostName}`}
        />
      </span>
    </HoverCard>
  );
}

// 输入卡下面的页脚：上面一条分割线，居中一行 工作位置（圆点）· tps · 上下文（读条 + 已用/总量）· 缓存命中。
// 悬停各出一张小卡（详细指标）；只读，不可点，不进审计。对话视图与审计页共用。
// 只给 token 与比率，不输出任何成本；算不出来的项不画。
export function StatusFoot({
  metrics,
  place,
}: {
  metrics: MetricsView;
  /** agent 现在工作的目录；壳没给（查不到）就不画 */
  place?: WorkingPlace | undefined;
}) {
  const l = metrics.line;
  const s = metrics.session;
  const t = metrics.tokens;
  const c = metrics.context;
  const where: { key: string; node: ReactNode }[] = place
    ? [{ key: "place", node: <Place place={place} /> }]
    : [];
  if (!s)
    return (
      <footer className="ch-foot" data-chatstats="">
        {where.map((w) => (
          <Fragment key={w.key}>{w.node}</Fragment>
        ))}
        {where.length > 0 && <i className="ch-sep" />}
        <span className="t-aux">暂无用量数据</span>
      </footer>
    );
  const items: { key: string; node: ReactNode }[] = [...where];
  if (l.tps !== null)
    items.push({
      key: "speed",
      node: (
        <HoverCard
          width={CARD_W}
          card={
            <Card title="速度与耗时">
              <Fact
                k="TTFT"
                v={dash(s.ttftMs === null ? null : fmtDuration(s.ttftMs))}
              />
              <Fact k="生成速度" v={s.tps === null ? "—" : `${s.tps} tok/s`} />
              <Fact
                k="模型用时"
                v={dash(s.modelMs === null ? null : fmtDuration(s.modelMs))}
              />
              <Fact
                k="工具调用用时"
                v={dash(s.toolMs === null ? null : fmtDuration(s.toolMs))}
              />
            </Card>
          }
        >
          <span className="ch-foot-i" data-foot="speed">
            <T v={`${l.tps} tok/s`} />
          </span>
        </HoverCard>
      ),
    });
  items.push({
    key: "ctx",
    node: (
      <HoverCard
        width={CARD_W}
        card={
          <Card title="上下文">
            <Fact k="占用" v={c?.pct == null ? "—" : `${c.pct}%`} />
            <Fact
              k="已用"
              v={
                c
                  ? `${fmtTokens(c.used)} / ${c.window ? fmtTokens(c.window) : "—"}`
                  : "—"
              }
            />
            {c?.window ? (
              <Fact k="还剩" v={fmtTokens(Math.max(0, c.window - c.used))} />
            ) : null}
          </Card>
        }
      >
        <span className="ch-foot-i" data-foot="context">
          {l.ctxLabel === null ? (
            <span className="t-aux">上下文 —</span>
          ) : l.ctxWindow ? (
            <ReadBar
              value={l.ctxUsed ?? 0}
              max={l.ctxWindow}
              label="上下文占用"
              text={l.ctxLabel}
            />
          ) : (
            // 窗口未知画不出比例，只给总占用
            <span className="t-mono">{l.ctxLabel}</span>
          )}
        </span>
      </HoverCard>
    ),
  });
  if (l.cacheHitPct !== null && t)
    items.push({
      key: "cache",
      node: (
        <HoverCard
          width={CARD_W}
          card={
            <Card title="用量与缓存">
              <Fact k="缓存命中" v={`${l.cacheHitPct}%`} />
              <Fact
                k="缓存读取"
                v={`${fmtTokens(t.cacheRead)} / ${fmtTokens(t.input)}`}
              />
              <Fact k="累计" v={`${fmtTokens(t.total)} tok`} />
            </Card>
          }
        >
          <span className="ch-foot-i" data-foot="cache">
            <T k="缓存 " v={`${l.cacheHitPct}%`} />
          </span>
        </HoverCard>
      ),
    });
  return (
    <footer className="ch-foot" data-chatstats="">
      {items.flatMap((it, i) => [
        ...(i === 0 ? [] : [<i key={`sep-${it.key}`} className="ch-sep" />]),
        <Fragment key={it.key}>{it.node}</Fragment>,
      ])}
    </footer>
  );
}
