import "../../test/contract/isolate.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { makeTmpDir } from "../../test/support/tmp-registry.js";
import { AgentSettingsFile } from "./agent-settings.js";
import { createSessionFactory } from "./factory.js";

// 会话里真的读到 `<ysHome>/settings.json`：真工厂 + 真 pi 设置（临时 agentDir），不碰 ~/.pi。
test("会话的 settingsManager 读到覆盖值，运行中改文件下一次查询就变", async () => {
  const agentDir = makeTmpDir("b24-factory-pi-");
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ compaction: { reserveTokens: 8000 } }),
  );
  const cwd = makeTmpDir("b24-factory-cwd-");
  const sessionDir = join(cwd, "sessions");
  mkdirSync(sessionDir);
  const file = join(makeTmpDir("b24-factory-ys-"), "settings.json");
  // 工厂按这个环境变量取 pi 的配置目录，指到临时目录
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const real = createSessionFactory({
    // 不解析模型：会话沿用 agentDir 里 pi 自己的配置
    resolver: { build: async () => null } as never,
    agentSettings: new AgentSettingsFile(file),
  });
  const session: AgentSession = await real({
    id: "b24-session",
    sessionDir,
    cwd,
    extensions: [],
  });
  try {
    // 文件没写：还是 pi 的值
    expect(session.settingsManager.getCompactionSettings().reserveTokens).toBe(
      8000,
    );
    writeFileSync(
      file,
      JSON.stringify({
        compaction: { reserveTokens: 16384, keepRecentTokens: 5000 },
        retry: { enabled: false, maxRetries: 1 },
      }),
    );
    // 不需要重建会话
    expect(session.settingsManager.getCompactionSettings()).toEqual({
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 5000,
    });
    expect(session.settingsManager.getRetrySettings()).toMatchObject({
      enabled: false,
      maxRetries: 1,
    });
    expect(session.autoRetryEnabled).toBe(false);
  } finally {
    session.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
