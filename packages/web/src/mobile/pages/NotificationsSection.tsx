import type { PushPolicy } from "../../api/push";
import { Button, Segmented, SettingRow, Switch } from "../../ui";
import type { usePush } from "../pwa/usePush";

type Push = ReturnType<typeof usePush>;

const WHY = {
  insecure: "当前是明文访问，没有后台通知。用 HTTPS 访问后才能开启。",
  unsupported: "这个浏览器不支持后台通知。",
  "ios-install": "先把元枢添加到主屏幕，从主屏幕打开后才能开启通知。",
  global:
    "用访问令牌登录的没有通知。在电脑上「设置 → 手机设备」添加这台手机，再用二维码登录。",
} as const;

const POLICIES: { value: PushPolicy; label: string }[] = [
  { value: "always", label: "总是" },
  { value: "unwatched", label: "没人看时" },
  { value: "delay", label: "延迟" },
];

const DELAYS = [
  { value: "10", label: "10 秒" },
  { value: "30", label: "30 秒" },
  { value: "60", label: "1 分钟" },
  { value: "300", label: "5 分钟" },
];

const POLICY_NOTE: Record<PushPolicy, string> = {
  always: "每次都发。",
  unwatched: "有人在看这个会话（电脑或手机）就不发。",
  delay: "过一会儿再发；期间处理了或有人在看就不发。",
};

// 通知设置：开启 / 关闭、三类事件各自的开关、什么时候发、测试一条。动作立即生效，不走保存条。
// 只管展示：状态与动作都从 usePush 来。
export function NotificationsSection({ push }: { push: Push }) {
  const { state, busy } = push;
  if (state.phase === "unavailable")
    return <p className="m-line t-aux">{WHY[state.why]}</p>;
  if (state.phase === "loading") return <p className="m-line t-aux">读取中…</p>;
  if (state.phase === "error")
    return <p className="m-line t-aux">读取通知设置失败，请稍后再试。</p>;
  if (state.phase === "off")
    return (
      <div className="m-block">
        <p className="m-line t-aux">
          {state.denied
            ? "通知权限被拒绝了，请在浏览器或系统设置里允许后再试。"
            : "需要你处理、出错、跑完时，在手机上弹一条通知。"}
        </p>
        <Button
          variant="primary"
          loading={busy}
          disabled={state.denied}
          onClick={() => void push.enable()}
        >
          开启通知
        </Button>
      </div>
    );

  const { prefs } = state;
  return (
    <div className="m-block">
      <SettingRow className="m-switch-row" label="需要你处理">
        <Switch
          aria-label="需要你处理时通知"
          checked={prefs.blocked}
          disabled={busy}
          onChange={(v) => void push.patch({ blocked: v })}
        />
      </SettingRow>
      <SettingRow className="m-switch-row" label="出错了">
        <Switch
          aria-label="出错时通知"
          checked={prefs.error}
          disabled={busy}
          onChange={(v) => void push.patch({ error: v })}
        />
      </SettingRow>
      <SettingRow className="m-switch-row" label="跑完了">
        <Switch
          aria-label="跑完时通知"
          checked={prefs.done}
          disabled={busy}
          onChange={(v) => void push.patch({ done: v })}
        />
      </SettingRow>
      <SettingRow label="什么时候发" description={POLICY_NOTE[prefs.policy]}>
        <Segmented
          aria-label="什么时候发"
          options={POLICIES}
          value={prefs.policy}
          disabled={busy}
          onChange={(policy) => void push.patch({ policy })}
        />
      </SettingRow>
      {prefs.policy === "delay" && (
        <SettingRow label="延迟多久">
          <Segmented
            aria-label="延迟多久"
            options={DELAYS}
            value={String(prefs.delaySec)}
            disabled={busy}
            onChange={(v) => void push.patch({ delaySec: Number(v) })}
          />
        </SettingRow>
      )}
      <div className="m-actions">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void push.test()}
        >
          发一条测试通知
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void push.disable()}
        >
          关闭通知
        </Button>
      </div>
    </div>
  );
}
