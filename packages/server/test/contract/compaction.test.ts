import "./isolate.js";
import { afterAll, expect, test } from "vitest";
import {
  at,
  countIn,
  makeEnv,
  openSession,
  startStub,
  textOf,
  writeModels,
} from "./harness.js";

// R2：压缩完成后追加到系统提示词的内容，必须出现在随后的请求里，且只出现一次。
const stub = await startStub((n) => `reply-${n} ${"filler ".repeat(40)}`);
afterAll(() => stub.close());

const MARK = "MARK-after-compaction";

for (const midConvo of [false, true]) {
  test(`R2 压缩后追加（supportsMidConvoSystemMessages=${midConvo}）`, async () => {
    stub.requests.length = 0;
    const env = makeEnv();
    writeModels(env, stub.url, {
      compat: { supportsMidConvoSystemMessages: midConvo },
    });
    let mark: string | undefined;
    const { session } = await openSession(env, {
      compaction: { keepRecentTokens: 1, reserveTokens: 1 },
      loader: {
        appendSystemPromptOverride: (base) => (mark ? [...base, mark] : base),
      },
    });
    for (const t of ["alpha", "beta", "gamma"]) await session.prompt(t);
    const before = stub.requests.length;
    const result = await session.compact();
    expect(result.summary.length).toBeGreaterThan(0);
    expect(stub.requests.length).toBeGreaterThan(before);

    mark = MARK;
    await session.reload();
    await session.prompt("after");
    session.dispose();

    const last = at(stub.requests, -1).body as {
      messages: Array<{ role: string; content?: unknown }>;
    };
    expect(countIn(last, MARK)).toBe(1);
    const carrier = last.messages.find((m) => textOf(m).includes(MARK));
    expect(carrier?.role).toBe("system");
    expect(JSON.stringify(last.messages)).toContain(
      result.summary.slice(0, 20),
    );
  });
}
