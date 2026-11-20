// 回放：agent 每个改变页面的动作做完后存的一张画面，按时间线翻看。画面区与实时画面同一个版式（16:10 居中），
// 下面是一行控制（会话、上一步 / 播放 / 下一步、进度、刷新）和当前步的说明。
import { useEffect, useRef, useState } from "react";
import { Empty, IconButton, Loading, Select, Slider } from "../../../../ui";
import {
  BackIcon,
  ForwardIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
} from "../../../../ui/icons";
import { nextIndex, sessionName, stepClock } from "./replayModel";
import { useReplay } from "./useReplay";

/** 自动播放每步停多久。 */
const PLAY_MS = 1200;

export interface ReplayViewProps {
  workspaceId: string;
  /** 当前锚点会话：它有回放就默认看它 */
  anchor: string | null;
  titles: ReadonlyMap<string, string>;
}

export function ReplayView({ workspaceId, anchor, titles }: ReplayViewProps) {
  const r = useReplay(workspaceId, anchor);
  const [playing, setPlaying] = useState(false);
  const step = r.steps[r.index];
  const count = r.steps.length;

  // 自动播放：每隔一会儿进一步，下一步的画面还没到就等；到头停下
  const live = useRef(r);
  live.current = r;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const { index, steps, settled, setIndex } = live.current;
      const next = nextIndex(index, steps.length);
      if (next === null) return setPlaying(false);
      if (settled(next)) setIndex(next);
    }, PLAY_MS);
    return () => clearInterval(timer);
  }, [playing]);

  // 换会话时停下
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只看会话变化
  useEffect(() => setPlaying(false), [r.sid]);

  const togglePlay = () => {
    if (playing) return setPlaying(false);
    // 在最后一步按播放：从头再来
    if (r.index >= count - 1) r.setIndex(0);
    setPlaying(true);
  };

  return (
    <section className="ws-wb-rp" aria-label="回放">
      <div className="ws-wb-stage">
        <div className="ws-wb-view">
          {r.frame && (
            <img
              className="ws-wb-canvas"
              src={r.frame}
              alt={step ? `第 ${r.index + 1} 步：${step.summary}` : "回放画面"}
            />
          )}
          <Veil r={r} />
        </div>
      </div>

      <div className="ws-wb-rp-bar">
        <Select
          className="ws-wb-rp-sel"
          aria-label="回放的会话"
          value={r.sid ?? ""}
          placeholder="没有回放"
          disabled={(r.sessions?.length ?? 0) === 0}
          options={(r.sessions ?? []).map((s) => ({
            value: s.sessionId,
            label: sessionName(s.sessionId, titles),
            hint: `${s.steps} 步`,
          }))}
          onChange={r.selectSession}
        />
        <IconButton
          size="sm"
          className="ws-wb-rp-prev"
          label="上一步"
          icon={<BackIcon size={13} />}
          disabled={r.index <= 0}
          onClick={() => r.setIndex(r.index - 1)}
        />
        <IconButton
          size="sm"
          className="ws-wb-rp-play"
          label={playing ? "暂停" : "播放"}
          icon={playing ? <PauseIcon size={13} /> : <PlayIcon size={13} />}
          disabled={count < 2}
          onClick={togglePlay}
        />
        <IconButton
          size="sm"
          className="ws-wb-rp-next"
          label="下一步"
          icon={<ForwardIcon size={13} />}
          disabled={r.index >= count - 1}
          onClick={() => r.setIndex(r.index + 1)}
        />
        <Slider
          className="ws-wb-rp-slider"
          aria-label="回放进度"
          aria-valuetext={`第 ${r.index + 1} 步，共 ${count} 步`}
          min={0}
          max={Math.max(0, count - 1)}
          step={1}
          value={r.index}
          disabled={count < 2}
          onChange={r.setIndex}
        />
        <span className="ws-wb-rp-count t-mono">
          {count === 0 ? "0 / 0" : `${r.index + 1} / ${count}`}
        </span>
        <IconButton
          size="sm"
          className="ws-wb-rp-reload"
          label="刷新回放"
          icon={<RefreshIcon size={13} />}
          onClick={r.reload}
        />
      </div>

      {step && (
        <div className="ws-wb-rp-note">
          <span className="t-plain">{step.summary}</span>
          <span className="ws-wb-rp-meta t-aux" title={step.url}>
            {stepClock(step.ts)}
            {step.title !== "" && ` · ${step.title}`}
          </span>
        </div>
      )}
    </section>
  );
}

/** 画面区盖的说明：读取中、读取失败、没有回放、这一步的画面没有了；有画面时返回 null。 */
function Veil({ r }: { r: ReturnType<typeof useReplay> }) {
  if (r.sessions === null)
    return (
      <div className="ws-wb-veil">
        <Loading>正在读取回放…</Loading>
      </div>
    );
  if (r.failed)
    return (
      <div className="ws-wb-veil" data-tone="danger">
        <Empty
          tone="danger"
          title="读不到回放"
          description="连不上 Server，点下面的刷新再试"
        />
      </div>
    );
  if (r.sessions.length === 0)
    return (
      <div className="ws-wb-veil">
        <Empty
          title="还没有回放"
          description="agent 在浏览器里每做完一个动作（打开、点击、输入、按键、你接管后交还），就会存一张画面，之后可以在这里按时间线翻看。"
        />
      </div>
    );
  if (r.missing)
    return (
      <div className="ws-wb-veil">
        <span className="t-aux">这一步的画面已经没有了</span>
      </div>
    );
  return null;
}
