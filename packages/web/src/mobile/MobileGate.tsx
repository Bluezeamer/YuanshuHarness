import { type FormEvent, type ReactNode, useState } from "react";
import { pairDevice } from "../api/devices";
import { type CallFailure, saveToken } from "../api/http";
import { Button, Field, Input } from "../ui";
import { defaultDeviceName } from "./deviceName";

const PAIR_PARAM = "pair";

const message = (f: CallFailure): string => {
  switch (f.kind) {
    case "unauthorized":
      return "配对码无效或已过期，请回到电脑上重新生成";
    case "rate_limited":
      return f.retryAfter
        ? `尝试过多，请 ${f.retryAfter} 秒后再试`
        : "尝试过多，请稍后再试";
    case "bad_request":
      return "设备名要 1–40 个字符";
    case "forbidden":
      return "当前来源不被允许";
    case "network":
      return "无法连接 Server";
    default:
      return "Server 返回了错误";
  }
};

// 配对：电脑上「添加设备」弹窗里的二维码打开 /m/?pair=<配对码>，这里用它换一个设备令牌存在本机。
// 没有 pair 参数就直接放行，交给后面的令牌门（直接输入访问令牌）。
export function MobileGate({ children }: { children: ReactNode }) {
  const [code, setCode] = useState(() =>
    new URLSearchParams(location.search).get(PAIR_PARAM),
  );
  const [name, setName] = useState(() =>
    defaultDeviceName(navigator.userAgent),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (code === null) return <>{children}</>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await pairDevice(code, name.trim());
    setBusy(false);
    if (!r.ok) return setError(message(r));
    saveToken(r.data.token);
    // 配对码是一次性的，别留在地址栏里
    history.replaceState(history.state, "", location.pathname);
    setCode(null);
  };

  return (
    <main className="sh-gate">
      <div className="sh-gate-card">
        <div className="sh-gate-brand t-block">
          <img src="/mark.svg" width={28} height={28} alt="" />
          元枢
        </div>
        <form onSubmit={submit} className="sh-gate-body">
          <p className="t-plain">把这台手机添加为设备，之后不用再输令牌。</p>
          <Field label="设备名" error={error ?? undefined}>
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" loading={busy}>
            添加
          </Button>
          <Button variant="ghost" onClick={() => setCode(null)}>
            改用访问令牌
          </Button>
        </form>
      </div>
    </main>
  );
}
