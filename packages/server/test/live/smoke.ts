// 手动冒烟：对真实 OpenAI 兼容端点跑一次最小会话。不断言模型行为，只确认 SDK 在真实端点上能走通。
// 端点与模型经环境变量传入，输出里不打印地址。由 scripts/contract-live.sh 调用。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const baseUrl = process.env.YUANSHU_LIVE_BASE_URL;
const modelId = process.env.YUANSHU_LIVE_MODEL;
if (!baseUrl || !modelId) {
  console.error(
    "缺少环境变量：YUANSHU_LIVE_BASE_URL 与 YUANSHU_LIVE_MODEL（YUANSHU_LIVE_API_KEY 可选）",
  );
  process.exit(2);
}

async function main(baseUrl: string, modelId: string) {
  const root = mkdtempSync(join(tmpdir(), "yuanshu-live-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        live: {
          baseUrl,
          api: "openai-completions",
          apiKey: process.env.YUANSHU_LIVE_API_KEY
            ? "$YUANSHU_LIVE_API_KEY"
            : "none",
          models: [{ id: modelId, reasoning: true, input: ["text", "image"] }],
        },
      },
    }),
  );

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const model = modelRuntime.getModel("live", modelId);
  if (!model) throw new Error("模型未出现在配置中");
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });
  try {
    await session.prompt("Reply with one short word.");
    const text = session.getLastAssistantText()?.trim();
    if (!text) throw new Error("真实端点没有返回任何助手文本");
    console.log(`冒烟通过：收到 ${text.length} 个字符的回复`);
  } finally {
    session.dispose();
  }
}

// 任何阶段的异常都经这里输出：先抹掉端点地址、主机名与 key，再截断。
const secrets = [
  baseUrl,
  new URL(baseUrl).host,
  process.env.YUANSHU_LIVE_API_KEY,
].filter((v): v is string => Boolean(v));
try {
  await main(baseUrl, modelId);
} catch (e) {
  let msg = String(e instanceof Error ? e.message : e);
  for (const v of secrets) msg = msg.split(v).join("<redacted>");
  console.error(`冒烟失败：${msg.slice(0, 300)}`);
  process.exitCode = 1;
}
