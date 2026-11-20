import type { AuthInteraction } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LoginManager, type LoginRuntime } from "./login.js";

// 假 runtime：login 的走向由每个用例决定，全程不联网、不走真 OAuth。
function fakeRuntime(run: (i: AuthInteraction) => Promise<unknown>) {
  const calls = { login: [] as string[], logout: [] as string[] };
  const signals: (AbortSignal | undefined)[] = [];
  const values: string[] = [];
  const runtime: LoginRuntime = {
    login(providerId, _type, interaction) {
      calls.login.push(providerId);
      signals.push(interaction.signal);
      // login 的返回值就是 run 的结果：run 挂住多久，登录就跑多久。
      return Promise.resolve(run(interaction));
    },
    async logout(providerId) {
      calls.logout.push(providerId);
    },
  };
  return { runtime, calls, signals, values };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("订阅登录会话", () => {
  test("auth_url 进 link；manual_code 提示经 answer 兑现后走到 done", async () => {
    const { runtime, values } = fakeRuntime(async (i) => {
      i.notify({
        type: "auth_url",
        url: "https://x/auth",
        instructions: "贴码",
      });
      values.push(await i.prompt({ type: "manual_code", message: "授权码" }));
    });
    const login = new LoginManager(runtime);
    const started = login.start("anthropic");
    await tick();
    const s = login.get("anthropic", started.loginId);
    expect(s).toMatchObject({
      status: "running",
      link: { url: "https://x/auth", instructions: "贴码" },
    });
    expect(s?.prompt).toMatchObject({ type: "manual_code", message: "授权码" });
    expect(
      login.answer(
        "anthropic",
        started.loginId,
        s?.prompt?.id as string,
        "abc",
      ),
    ).toBe(true);
    await tick();
    expect(values).toEqual(["abc"]);
    expect(login.get("anthropic", started.loginId)).toMatchObject({
      status: "done",
      prompt: null,
      error: null,
    });
    login.dispose();
  });

  test("device_code 进 device，无需 prompt 也走到 done", async () => {
    let finish: () => void = () => {};
    const { runtime } = fakeRuntime(async (i) => {
      i.notify({
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://x/device",
        expiresInSeconds: 900,
      });
      await new Promise<void>((r) => {
        finish = r;
      });
    });
    const login = new LoginManager(runtime);
    const started = login.start("github-copilot");
    await tick();
    expect(login.get("github-copilot", started.loginId)).toMatchObject({
      status: "running",
      device: {
        userCode: "ABCD-1234",
        verificationUri: "https://x/device",
        expiresInSeconds: 900,
      },
      prompt: null,
    });
    finish();
    await tick();
    expect(login.get("github-copilot", started.loginId)?.status).toBe("done");
    login.dispose();
  });

  test("login 抛错 → failed 且 error 是消息文本；secret 输入值不出现在状态里", async () => {
    const { runtime, values } = fakeRuntime(async (i) => {
      values.push(await i.prompt({ type: "secret", message: "API Key" }));
      throw new Error("兑换失败");
    });
    const login = new LoginManager(runtime);
    const started = login.start("openai");
    await tick();
    const prompt = login.get("openai", started.loginId)?.prompt;
    login.answer("openai", started.loginId, prompt?.id as string, "sk-secret");
    await tick();
    const s = login.get("openai", started.loginId);
    expect(s).toMatchObject({ status: "failed", error: "兑换失败" });
    expect(values).toEqual(["sk-secret"]);
    expect(JSON.stringify(s)).not.toContain("sk-secret");
    login.dispose();
  });

  test("cancel 落 cancelled，挂起提示被拒，login 收到的 signal 已 aborted", async () => {
    let rejected: unknown = null;
    const { runtime, signals } = fakeRuntime(async (i) => {
      await i.prompt({ type: "text", message: "账号" }).catch((e) => {
        rejected = e;
      });
    });
    const login = new LoginManager(runtime);
    const started = login.start("anthropic");
    await tick();
    expect(login.cancel("anthropic", started.loginId)).toBe(true);
    await tick();
    expect(login.get("anthropic", started.loginId)).toMatchObject({
      status: "cancelled",
      prompt: null,
    });
    expect(rejected).toBeInstanceOf(Error);
    expect(signals[0]?.aborted).toBe(true);
    expect(login.cancel("anthropic", started.loginId)).toBe(true); // 幂等
    expect(login.cancel("anthropic", "nope")).toBe(false);
    login.dispose();
  });

  test("同一供应商再 start 取消旧的，新会话 running", async () => {
    const { runtime } = fakeRuntime(() => new Promise(() => {}));
    const login = new LoginManager(runtime);
    const first = login.start("anthropic");
    await tick();
    const second = login.start("anthropic");
    await tick();
    expect(login.get("anthropic", first.loginId)?.status).toBe("cancelled");
    expect(login.get("anthropic", second.loginId)?.status).toBe("running");
    login.dispose();
  });

  test("超时 → failed，error 登录超时", async () => {
    vi.useFakeTimers();
    const { runtime } = fakeRuntime(() => new Promise(() => {}));
    const login = new LoginManager(runtime, { ttlMs: 1000 });
    const started = login.start("anthropic");
    await vi.advanceTimersByTimeAsync(1000);
    expect(login.get("anthropic", started.loginId)).toMatchObject({
      status: "failed",
      error: "登录超时",
    });
    login.dispose();
  });

  test("结束后的会话在保留期过后 get 得 null", async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const { runtime } = fakeRuntime(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    const login = new LoginManager(runtime);
    const started = login.start("anthropic");
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(login.get("anthropic", started.loginId)?.status).toBe("done");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(login.get("anthropic", started.loginId)).toBeNull();
    login.dispose();
  });

  test("answer 用错 promptId 返回 false 且不兑现当前提示", async () => {
    const { runtime, values } = fakeRuntime(async (i) => {
      values.push(await i.prompt({ type: "text", message: "账号" }));
    });
    const login = new LoginManager(runtime);
    const started = login.start("anthropic");
    await tick();
    const prompt = login.get("anthropic", started.loginId)?.prompt;
    expect(login.answer("anthropic", started.loginId, "wrong", "v")).toBe(
      false,
    );
    expect(login.get("anthropic", started.loginId)?.prompt).toMatchObject({
      id: prompt?.id,
    });
    expect(
      login.answer("anthropic", started.loginId, prompt?.id as string, "v"),
    ).toBe(true);
    await tick();
    expect(values).toEqual(["v"]);
    login.dispose();
  });

  test("别的供应商的 id 读不到、答不了、取消不了这个登录", async () => {
    const { runtime } = fakeRuntime(async (i) => {
      await i.prompt({ type: "text", message: "账号" });
    });
    const login = new LoginManager(runtime);
    const started = login.start("anthropic");
    await tick();
    const prompt = login.get("anthropic", started.loginId)?.prompt;
    expect(login.get("openai", started.loginId)).toBeNull();
    expect(
      login.answer("openai", started.loginId, prompt?.id as string, "v"),
    ).toBe(false);
    expect(login.cancel("openai", started.loginId)).toBe(false);
    expect(login.get("anthropic", started.loginId)).toMatchObject({
      status: "running",
      prompt: { id: prompt?.id },
    });
    login.dispose();
  });

  test("流程自己中止了提示（如回调先收到码）：挂起的提示被清掉，登录照常往下走", async () => {
    const ac = new AbortController();
    let rejected: unknown = null;
    let finish: () => void = () => {};
    const { runtime } = fakeRuntime(async (i) => {
      await i
        .prompt({ type: "manual_code", message: "授权码", signal: ac.signal })
        .catch((e) => {
          rejected = e;
        });
      await new Promise<void>((r) => {
        finish = r;
      });
    });
    const login = new LoginManager(runtime);
    const started = login.start("anthropic");
    await tick();
    expect(login.get("anthropic", started.loginId)?.prompt).not.toBeNull();
    ac.abort();
    await tick();
    expect(rejected).toBeInstanceOf(Error);
    expect(login.get("anthropic", started.loginId)).toMatchObject({
      status: "running",
      prompt: null,
    });
    finish();
    await tick();
    expect(login.get("anthropic", started.loginId)?.status).toBe("done");
    login.dispose();
  });
});
