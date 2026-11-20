import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPairing } from "../../../api/devices";
import { loadToken } from "../../../api/http";
import {
  Button,
  copyText,
  Field,
  InlineNotice,
  Input,
  Loading,
  Modal,
  toast,
} from "../../../ui";
import { addressProblem, fmtRemaining, pairingUrl, remainingMs } from "./model";

// 二维码库自带一批色值，按需加载，不进入口包（与画布同理）
const QrCode = lazy(() =>
  import("./QrCode").then((m) => ({ default: m.QrCode })),
);

/** 配对码有人用过没有：设备列表里多出一台就是用了。轮询间隔 */
const WATCH_MS = 2500;

type Pairing = { code: string; expiresAt: string };

// 添加设备：生成一个 5 分钟有效的一次性配对码，把「地址 + 配对码」画成二维码给手机扫；
// 地址默认是当前浏览器的地址（在 localhost 上打开桌面时手机打不开，提示改成局域网地址）。
export function AddDeviceDialog({
  open,
  onClose,
  deviceCount,
  reload,
}: {
  open: boolean;
  onClose(): void;
  /** 现在已有几台：多出来就说明刚才这个码被用了 */
  deviceCount: number;
  /** 重新读设备列表，返回台数（读失败返回 null） */
  reload(): Promise<number | null>;
}) {
  const [base, setBase] = useState(() => window.location.origin);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const baseline = useRef(deviceCount);

  const issue = useCallback(async () => {
    setPairing(null);
    setFailed(false);
    const r = await createPairing(loadToken());
    if (r.ok) setPairing(r.data);
    else setFailed(true);
  }, []);

  // 每次打开都是一张新的码；关掉就作废（服务端 5 分钟后自己过期）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在打开时取一次台数基线
  useEffect(() => {
    if (!open) return;
    baseline.current = deviceCount;
    setBase(window.location.origin);
    void issue();
  }, [open, issue]);

  useEffect(() => {
    if (!open || !pairing) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open, pairing]);

  // 码还有效时盯着设备列表：多出一台就是配对成功
  const live = pairing !== null && remainingMs(pairing.expiresAt, now) > 0;
  useEffect(() => {
    if (!open || !live) return;
    const t = setInterval(() => {
      void reload().then((n) => {
        if (n !== null && n > baseline.current) {
          toast("手机已添加", { tone: "ok" });
          onClose();
        }
      });
    }, WATCH_MS);
    return () => clearInterval(t);
  }, [open, live, reload, onClose]);

  const problem = addressProblem(base);
  const url =
    pairing && problem !== "invalid" ? pairingUrl(base, pairing.code) : null;
  const left = pairing ? remainingMs(pairing.expiresAt, now) : 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="添加手机"
      description="用手机扫码打开，这台手机之后就不用再输令牌。码 5 分钟内有效，只能用一次。"
      size="md"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose}>
            关闭
          </Button>
          <Button variant="outline" size="lg" onClick={() => void issue()}>
            重新生成
          </Button>
        </>
      }
    >
      <div className="st-dv-add">
        <Field
          label="手机访问的地址"
          hint="手机能打开的 Server 地址：电脑在局域网里的 IP 加端口，或你的域名。"
        >
          {(c) => (
            <Input
              {...c}
              mono
              value={base}
              onChange={(e) => setBase(e.target.value)}
            />
          )}
        </Field>
        {problem === "local" && (
          <InlineNotice tone="warn">
            这是本机地址，手机打不开。改成电脑在局域网里的地址，例如
            192.168.1.20:7431。
          </InlineNotice>
        )}
        {problem === "invalid" && (
          <InlineNotice tone="danger">地址不对，没法生成二维码。</InlineNotice>
        )}
        {failed && (
          <InlineNotice tone="danger">生成配对码失败，请重试。</InlineNotice>
        )}
        {!pairing && !failed && <Loading>生成配对码…</Loading>}
        {pairing && url && live && (
          <>
            <Suspense fallback={<Loading>生成二维码…</Loading>}>
              <QrCode text={url} label="配对二维码" />
            </Suspense>
            <p className="st-dv-left t-aux">{fmtRemaining(left)}后失效</p>
            <div className="st-dv-link">
              <code className="st-dv-url t-mono">{url}</code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void copyText(url).then((ok) =>
                    toast(ok ? "已复制链接" : "无法写入剪贴板", {
                      tone: ok ? "ok" : "warn",
                    }),
                  )
                }
              >
                复制链接
              </Button>
            </div>
          </>
        )}
        {pairing && !live && (
          <InlineNotice tone="warn">
            配对码已失效，点「重新生成」。
          </InlineNotice>
        )}
      </div>
    </Modal>
  );
}
