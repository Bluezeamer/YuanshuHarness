// 附件功能的端到端测试：真实 Server + 真实会话工厂 + 假模型端点。
// 覆盖上传/读取、隐藏 directory、send_message attachments 的重算与标记注入、事件/历史投影、
// 图片与非图片的差异、以及 attachment directory 的权限围栏与迁出。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResizedImage } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type Frame, waitFor } from "../../test/support/frames.js";
import { type StubReply, startStub } from "../../test/support/stub.js";
import { type Ack, TestClient } from "../../test/support/ws-client.js";
import { createServer, type YuanshuServer } from "../server.js";
import { createSessionFactory } from "../session/factory.js";
import type { ImageResize } from "../session/image-compression.js";
import { PI_IMAGE_COMPRESSION } from "../store/defaults.js";

let plan: StubReply[] = [];
const stub = await startStub(() => plan.shift() ?? "好的");

let root = "";
let server: YuanshuServer;
let http = "";
let wsBase = "";
let webRoot = "";
let startDir = "";
let providerId = "";

const boot = async (): Promise<void> => {
  server = createServer(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(root, "data"),
      allowCidrs: [],
    },
    {
      webRoot,
      startDir,
      makeSessionFactory: createSessionFactory,
      imageResize: fakeResize,
      logStream: { write() {} },
    },
  );
  const addr = await server.start();
  http = `http://${addr.host}:${addr.port}`;
  wsBase = http.replace("http", "ws");
};

const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${http}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const ok = async (method: string, url: string, body?: unknown) => {
  const r = await call(method, url, body);
  if (r.status >= 300)
    throw new Error(
      `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`,
    );
  return r.body;
};

const newSession = (): Promise<{ id: string }> =>
  ok("POST", "/api/v1/sessions", {}) as Promise<{ id: string }>;

const upload = async (sessionId: string, name: string, data: Uint8Array) => {
  const res = await fetch(
    `${http}/api/v1/sessions/${sessionId}/attachments?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: data,
    },
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};

// 合法的 1x1 PNG：SDK 的图片处理要能真正解析它，才会序列化成 ImageInput。
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// 只需要魔数能被识别成 image/gif；GIF 不作为图片模态交给模型。
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");

// 另一个合法的 1x1 PNG：用来分辨模型收到的是压缩后的数据还是原图。
const COMPRESSED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const resizeCalls: {
  bytes: Uint8Array;
  mime: string;
  options: {
    maxWidth: number;
    maxHeight: number;
    maxBytes: number;
    jpegQuality: number;
  };
}[] = [];
const defaultResizeResult: ResizedImage = {
  data: PNG.toString("base64"),
  mimeType: "image/png",
  originalWidth: 1,
  originalHeight: 1,
  width: 1,
  height: 1,
  wasResized: false,
};
let resizeResult: ResizedImage | null = defaultResizeResult;

// 测试替换真实 WASM 压缩：只记录参数并按预设返回，避免依赖 Photon。
const fakeResize: ImageResize = async (bytes, mime, options) => {
  resizeCalls.push({ bytes, mime, options });
  return resizeResult;
};

// 图片压缩设置必须"请求时实时读"，所以每个用例都自己写回要用的配置。
const setCompression = (cfg = PI_IMAGE_COMPRESSION) =>
  ok("PUT", "/api/v1/defaults", { imageCompression: cfg });

// 让会话切到支持图片输入的模型。
const useImageModel = async (sessionId: string) => {
  const config = await ok("GET", `/api/v1/sessions/${sessionId}/config`);
  await ok("PATCH", `/api/v1/sessions/${sessionId}/config`, {
    baseRev: config.rev,
    patch: {
      model: {
        mode: "explicit",
        provider: providerId,
        model: "mi",
        reasoning: "off",
      },
    },
  });
};

beforeEach(() => {
  resizeCalls.length = 0;
  resizeResult = defaultResizeResult;
});

const contentText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter(
            (b) =>
              b &&
              typeof b === "object" &&
              (b as { type?: unknown }).type === "text",
          )
          .map((b) => String((b as { text?: unknown }).text ?? ""))
          .join("")
      : "";

const userContent = (body: Record<string, unknown>): unknown => {
  const messages = body.messages as { role: string; content?: unknown }[];
  return messages.filter((m) => m.role === "user").at(-1)?.content;
};
const userText = (body: Record<string, unknown>): string =>
  contentText(userContent(body));

// 本次请求里按顺序出现的工具结果文本
const toolResults = (body: Record<string, unknown>): string[] =>
  ((body.messages ?? []) as { role: string; content: unknown }[])
    .filter((m) => m.role === "tool")
    .map((m) => contentText(m.content));

interface Turn {
  ack: Ack;
  frames: Frame[];
  // 本轮里模型收到的请求体（按发生顺序）
  requests: Record<string, unknown>[];
  approvals: string[];
}

// 发一条消息并等这一轮结束；遇到审批弹窗按 decide 作答。
async function turn(
  sessionId: string,
  message: Record<string, unknown>,
  decide: (tool: string) => "allow" | "deny" = () => "allow",
): Promise<Turn> {
  const from = stub.requests.length;
  const client = await TestClient.connect(
    `${wsBase}/api/v1/sessions/${sessionId}/stream`,
  );
  const approvals: string[] = [];
  let answered = 0;
  try {
    const ack = await client.command("send_message", message);
    if (!ack.ok) return { ack, frames: client.frames, requests: [], approvals };
    await waitFor(
      () => {
        for (const f of client.frames.slice(answered)) {
          answered++;
          if (f.type === "prompt.requested" && f.data.source === "approval") {
            const tool = String(
              (f.data.detail as { tool?: unknown } | undefined)?.tool,
            );
            approvals.push(tool);
            const opts = f.data.options as { id: string }[];
            const pick = opts.find((o) => o.id === decide(tool)) ?? opts[0];
            void client.command("answer_prompt", {
              promptId: f.data.promptId,
              optionId: pick?.id,
            });
          }
        }
        return client.frames.some((f) => f.type === "run.ended");
      },
      "run.ended",
      30_000,
    );
    return {
      ack,
      frames: client.frames,
      requests: stub.requests.slice(from).map((r) => r.body),
      approvals,
    };
  } finally {
    client.close();
  }
}

const userMessageFrame = (t: Turn): Frame | undefined =>
  t.frames
    .filter((f) => f.type === "message.ended" && f.data.role === "user")
    .at(-1);

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "yuanshu-attach-")));
  webRoot = path.join(root, "web");
  mkdirSync(webRoot);
  writeFileSync(path.join(webRoot, "index.html"), "<!doctype html>");
  startDir = path.join(root, "start");
  mkdirSync(startDir);
  await boot();
  const provider = await ok("POST", "/api/v1/providers", {
    name: "附件 stub",
    slug: "attach-stub",
    api: "openai-completions",
    baseUrl: stub.url,
    apiKey: "k",
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        levels: [],
        input: ["text"],
        ctx: 32000,
        out: 4096,
        source: "manual",
      },
      {
        id: "mi",
        name: "mi",
        reasoning: false,
        levels: [],
        input: ["text", "image"],
        ctx: 32000,
        out: 4096,
        source: "manual",
      },
    ],
  });
  providerId = provider.id;
  await ok("PUT", "/api/v1/default-model", {
    provider: provider.id,
    model: "m",
  });
});

afterAll(async () => {
  await server?.stop();
  await stub.close();
  rmSync(root, { recursive: true, force: true });
});

test("上传：流式落盘，返回原始名/mime/size/相对路径；读取与下载", async () => {
  const s = await newSession();
  const data = Buffer.from("hello attachment\n");
  const up = await upload(s.id, "note.txt", data);
  expect(up.status).toBe(201);
  expect(up.body).toMatchObject({
    name: "note.txt",
    mime: "text/plain",
    size: data.length,
  });
  expect(up.body.path).toMatch(
    /^\.\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[A-Za-z0-9._-]+$/,
  );
  // 确实落在 <data-dir>/attachments/<工作区>/ 下（附件区按工作区存放，不再按会话）
  const workspaceId = (
    await ok("GET", "/api/v1/workspaces")
  ).workspaces.flatMap((w: { id: string }) => [w.id]);
  expect(
    workspaceId.some((id: string) =>
      existsSync(
        path.join(root, "data", "attachments", id, up.body.path.slice(2)),
      ),
    ),
  ).toBe(true);

  const url = `${http}/api/v1/sessions/${s.id}/attachments/content?path=${encodeURIComponent(up.body.path)}`;
  const read = await fetch(url);
  expect(read.status).toBe(200);
  expect(read.headers.get("content-type")).toBe("text/plain");
  expect(read.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await read.arrayBuffer()).equals(data)).toBe(true);

  const dl = await fetch(`${url}&download=1`);
  expect(dl.status).toBe(200);
  expect(dl.headers.get("content-disposition")).toContain("attachment;");
  expect(dl.headers.get("content-disposition")).toContain("note.txt");
});

test("上传：中文文件名原样落盘（目录部分仍是 ASCII）；图片按魔数识别", async () => {
  const s = await newSession();
  const up = await upload(s.id, "报告 v2.pdf", Buffer.from("%PDF-1.4"));
  expect(up.body.name).toBe("报告 v2.pdf");
  expect(up.body.mime).toBe("application/pdf");
  expect(up.body.path).toMatch(/^\.\/[\d-]+\/[0-9a-f]{8}-报告 v2\.pdf$/);

  const img = await upload(s.id, "blob.bin", PNG);
  expect(img.body.mime).toBe("image/png");
});

test("上传/读取的校验：越界、不存在、会话不存在、缺 name", async () => {
  const s = await newSession();
  const up = await upload(s.id, "a.txt", Buffer.from("a"));
  expect(up.status).toBe(201);
  const contentUrl = (p: string) =>
    `${http}/api/v1/sessions/${s.id}/attachments/content?path=${encodeURIComponent(p)}`;
  for (const bad of [
    "../x",
    "/etc/passwd",
    "./a/../../x",
    "./a/../b",
    "a\\..\\b",
  ])
    expect((await fetch(contentUrl(bad))).status, bad).toBe(400);
  expect(
    (await fetch(contentUrl("./2026-01-01/aaaaaaaa-nope.txt"))).status,
  ).toBe(404);
  expect(
    (await fetch(`${http}/api/v1/sessions/${s.id}/attachments/content`)).status,
  ).toBe(400);
  expect((await upload("nope", "a.txt", Buffer.from("a"))).status).toBe(404);
  expect(
    (
      await fetch(
        `${http}/api/v1/sessions/${s.id}/attachments/content?path=${encodeURIComponent(up.body.path)}`,
      )
    ).status,
  ).toBe(200);

  const noName = await fetch(`${http}/api/v1/sessions/${s.id}/attachments`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array([1]),
  });
  expect(noName.status).toBe(400);
});

test("隐藏 directory：用户接口看不到，agent 的 list_directories 单列附件区；附件区不能当工作目录切换", async () => {
  const s = await newSession();
  const names = async () =>
    (await ok("GET", `/api/v1/sessions/${s.id}/directories`)).directories.map(
      (w: { name: string }) => w.name,
    );
  const globalNames = async () =>
    (await ok("GET", "/api/v1/directories")).directories.map(
      (w: { name: string }) => w.name,
    );
  expect(await names()).not.toContain("attachment");
  expect(await globalNames()).not.toContain("attachment");
  expect(
    (await ok("GET", "/api/v1/environments")).environments.map(
      (e: { id: string }) => e.id,
    ),
  ).not.toContain("attachment");

  const up = await upload(s.id, "x.txt", Buffer.from("x"));
  expect(await names()).not.toContain("attachment");
  expect(await globalNames()).not.toContain("attachment");

  plan = [{ tool: "list_directories", args: {} }, "看到了"];
  const listed = await turn(s.id, { text: "看看目录" });
  const listText = toolResults(listed.requests[1] ?? {}).join("\n");
  expect(listText).toContain("attachment");
  expect(listText).toContain('host="attachment"');

  // 附件区不是目录：带目录名的写法被地址簿拒，并告诉模型怎么直接寻址
  plan = [
    { tool: "switch_directory", args: { directory: "attachment:x" } },
    "切不过去",
  ];
  const switched = await turn(s.id, { text: "切过去" });
  const switchedText = toolResults(switched.requests[1] ?? {}).join("\n");
  expect(switchedText).toContain("The attachment host is not a directory.");
  expect(switchedText).toContain('host="attachment"');

  // 当前目录没变：下一轮里也没有切换通知
  plan = ["还在原处"];
  const next = await turn(s.id, { text: "现在在哪" });
  expect(JSON.stringify(next.requests[0])).not.toContain(
    "current directory is now",
  );

  // 附件可以直接寻址读写，不需要切换
  plan = [
    {
      tool: "read",
      args: {
        host: "attachment",
        path: up.body.path.replace(/^\./, ""),
      },
    },
    "读到了",
  ];
  const read = await turn(s.id, { text: "直接读" });
  expect(read.approvals).toEqual([]);
  expect(toolResults(read.requests[1] ?? {}).join("\n")).toContain("x");
});

test("send_message attachments：服务端重算 mime/size、注入标记、事件与历史投影", async () => {
  const s = await newSession();
  const up = await upload(s.id, "note.txt", Buffer.from("abc"));
  plan = ["好的"];
  const t = await turn(s.id, {
    text: "看附件",
    // 客户端伪造的 name/mime/size 一律不采信
    attachments: [
      { path: up.body.path, name: "伪造.png", mime: "image/png", size: 999 },
    ],
  });
  expect(t.ack).toMatchObject({ ok: true });
  expect(userText(t.requests[0] as Record<string, unknown>)).toBe(
    `看附件\n\n[attach_file] attachment:${(up.body.path as string).replace(/^\./, "")} (text/plain, 3 B)`,
  );

  const expected = [
    {
      name: "note.txt",
      mime: "text/plain",
      sizeText: "3 B",
      path: up.body.path,
    },
  ];
  // 事件投影：text 已剥离标记，附件单独给出
  const um = userMessageFrame(t);
  expect(um?.data.text).toBe("看附件");
  expect(um?.data.attachments).toEqual(expected);

  // 历史投影与事件同源、同一 helper
  const history = await ok("GET", `/api/v1/sessions/${s.id}/messages`);
  expect(history.messages[0]).toMatchObject({ role: "user", text: "看附件" });
  expect(history.messages[0].attachments).toEqual(expected);
  expect(JSON.stringify(history.messages[0])).not.toContain("[attach_file]");
});

test("answer_prompt 带附件：input: rich 的弹窗把标记行与图片交给模型", async () => {
  const s = await newSession();
  await useImageModel(s.id);
  await setCompression({ ...PI_IMAGE_COMPRESSION, enabled: false });
  const up = await upload(s.id, "p.png", PNG);

  // 第一轮让模型问一个自由输入的问题（没有 options，照样接受附件），拿到答复后再回一句
  plan = [{ tool: "ask_user", args: { question: "看看这张图" } }, "看到了"];
  const client = await TestClient.connect(
    `${wsBase}/api/v1/sessions/${s.id}/stream`,
  );
  try {
    expect((await client.command("send_message", { text: "先聊" })).ok).toBe(
      true,
    );
    await waitFor(
      () => client.frames.some((f) => f.type === "prompt.requested"),
      "prompt.requested",
    );
    const req = client.frames.find((f) => f.type === "prompt.requested");
    expect(req?.data).toMatchObject({ input: "rich", options: [] });
    const answered = await client.command("answer_prompt", {
      promptId: req?.data.promptId,
      text: "看图",
      attachments: [{ path: up.body.path }],
    });
    expect(answered).toMatchObject({ ok: true });
    await waitFor(
      () => client.frames.some((f) => f.type === "run.ended"),
      "run.ended",
    );
    // 工具结果里有标记行与原图
    const body = JSON.stringify(stub.requests.at(-1)?.body);
    expect(body).toContain(
      `[attach_file] attachment:${(up.body.path as string).replace(/^\./, "")}`,
    );
    expect(body).toContain(`data:image/png;base64,${PNG.toString("base64")}`);
  } finally {
    // 目标还在续跑：暂停它（会中断本轮），别让它影响后面的用例
    await client.command("pause_goal").catch(() => {});
    client.close();
  }
});

test("answer_prompt：选项 + 文字 + 附件的组合都收（rich 弹窗）", async () => {
  const s = await newSession();
  await useImageModel(s.id);
  await setCompression({ ...PI_IMAGE_COMPRESSION, enabled: false });
  const up = await upload(s.id, "p.png", PNG);

  plan = [
    { tool: "ask_user", args: { question: "选哪个？", options: ["甲", "乙"] } },
    "好的",
  ];
  const client = await TestClient.connect(
    `${wsBase}/api/v1/sessions/${s.id}/stream`,
  );
  try {
    expect((await client.command("send_message", { text: "先聊" })).ok).toBe(
      true,
    );
    await waitFor(
      () => client.frames.some((f) => f.type === "prompt.requested"),
      "prompt.requested",
    );
    const req = client.frames.find((f) => f.type === "prompt.requested");
    // 有选项的弹窗同样有输入框，也收附件
    expect(req?.data).toMatchObject({ input: "rich" });
    expect(req?.data.options).toHaveLength(2);
    const answered = await client.command("answer_prompt", {
      promptId: req?.data.promptId,
      optionId: "1",
      text: "顺便看图",
      attachments: [{ path: up.body.path }],
    });
    expect(answered).toMatchObject({ ok: true });
    await waitFor(
      () => client.frames.some((f) => f.type === "run.ended"),
      "run.ended",
    );
    const body = JSON.stringify(stub.requests.at(-1)?.body);
    expect(body).toContain("The user selected: 乙");
    expect(body).toContain("The user also wrote: 顺便看图");
    expect(body).toContain(`data:image/png;base64,${PNG.toString("base64")}`);
  } finally {
    await client.command("pause_goal").catch(() => {});
    client.close();
  }
});

test("answer_prompt：带附件答 input: text 的弹窗被拒（审批）", async () => {
  const s = await newSession();
  // 写到工作区外 → 弹审批（input: "text"）
  const up = await upload(s.id, "note.txt", Buffer.from("abc"));
  // 写工作区之外（root 不是会话的目录）→ 弹审批
  plan = [
    {
      tool: "write",
      args: {
        host: "local",
        path: path.join(root, "outside.txt"),
        content: "x",
      },
    },
    "好的",
  ];
  const client = await TestClient.connect(
    `${wsBase}/api/v1/sessions/${s.id}/stream`,
  );
  try {
    expect((await client.command("send_message", { text: "先聊" })).ok).toBe(
      true,
    );
    await waitFor(
      () => client.frames.some((f) => f.type === "prompt.requested"),
      "prompt.requested",
    );
    const req = client.frames.find((f) => f.type === "prompt.requested");
    expect(req?.data).toMatchObject({ source: "approval", input: "text" });
    const rejected = await client.command("answer_prompt", {
      promptId: req?.data.promptId,
      optionId: "allow",
      attachments: [{ path: up.body.path }],
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe("bad_request");
    // 弹窗还在：只写字照样能答
    const ok = await client.command("answer_prompt", {
      promptId: req?.data.promptId,
      text: "就这一次",
    });
    expect(ok).toMatchObject({ ok: true });
    await waitFor(
      () => client.frames.some((f) => f.type === "run.ended"),
      "run.ended",
    );
  } finally {
    await client.command("pause_goal").catch(() => {});
    client.close();
  }
});

test("回退到带附件的用户消息：editor 拆出原文与附件，旧字段不再出现", async () => {
  const s = await newSession();
  const up = await upload(s.id, "note.txt", Buffer.from("abc"));
  plan = ["好的"];
  await turn(s.id, { text: "看附件", attachments: [{ path: up.body.path }] });

  const list = await ok("GET", `/api/v1/sessions/${s.id}/user-messages`);
  const entryId = (list.messages as { entryId: string }[])[0]?.entryId;
  const res = await ok("POST", `/api/v1/sessions/${s.id}/navigate`, {
    entryId,
  });
  expect(res.editor).toEqual({
    text: "看附件",
    attachments: [
      {
        name: "note.txt",
        mime: "text/plain",
        sizeText: "3 B",
        path: up.body.path,
      },
    ],
  });
  expect(res.editorText).toBeUndefined();
});

test("目标带附件：set_goal 用原文建目标并带图片注入第一轮，edit_goal 清空后只带标记行", async () => {
  const s = await newSession();
  await useImageModel(s.id);
  // 关掉压缩，模型请求里的 base64 就是磁盘上的原图，便于逐字节核对
  await setCompression({ ...PI_IMAGE_COMPRESSION, enabled: false });
  const up = await upload(s.id, "p.png", PNG);
  const original = `data:image/png;base64,${PNG.toString("base64")}`;

  const from = stub.requests.length;
  const client = await TestClient.connect(
    `${wsBase}/api/v1/sessions/${s.id}/stream`,
  );
  try {
    const ack = await client.command("set_goal", {
      text: "看图",
      attachments: [{ path: up.body.path }],
    });
    expect(ack).toMatchObject({ ok: true });
    const goal = () =>
      client.frames.filter((f) => f.type === "goal.updated").at(-1)?.data
        .goal as Record<string, unknown> | undefined;
    // 目标的文字是原文，不带标记行；附件引用按磁盘重算
    expect(goal()).toMatchObject({
      text: "看图",
      attachments: [
        {
          name: "p.png",
          mime: "image/png",
          sizeText: `${PNG.length} B`,
          path: up.body.path,
        },
      ],
    });
    // 卡片带附件名
    const card = client.frames
      .filter(
        (f) =>
          f.type === "notice" &&
          f.data.kind === "goal" &&
          (f.data.goal as { event: string }).event === "set",
      )
      .at(-1);
    expect(card?.data.goal).toMatchObject({ files: ["p.png"] });

    // 第一轮：注入消息里既有标记行也有图片
    await waitFor(() => stub.requests.length > from, "第一轮");
    const injected = () =>
      (
        (stub.requests.at(-1)?.body.messages ?? []) as {
          role: string;
          content: unknown;
        }[]
      ).at(-1);
    expect(JSON.stringify(injected())).toContain(original);
    expect(JSON.stringify(injected())).toContain(
      `[attach_file] attachment:${(up.body.path as string).replace(/^\./, "")}`,
    );

    // 清空附件：文字仍用原文；先暂停再改，免得和自动续跑抢顺序
    expect((await client.command("pause_goal")).ok).toBe(true);
    expect((await client.command("edit_goal", { attachments: [] })).ok).toBe(
      true,
    );
    expect(goal()).not.toHaveProperty("attachments");
    expect(goal()?.text).toBe("看图");
    const before = stub.requests.length;
    expect((await client.command("resume_goal")).ok).toBe(true);
    await waitFor(() => stub.requests.length > before, "清空后的一轮");
    const after = JSON.stringify(injected());
    expect(after).not.toContain(original);
    expect(after).not.toContain("[attach_file]");
  } finally {
    client.close();
  }
});

test("非图片附件不读字节：大文件不会进入模型请求", async () => {
  const s = await newSession();
  const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
  const up = await upload(s.id, "big.log", big);
  expect(up.body).toMatchObject({ mime: "text/plain", size: big.length });
  plan = ["好"];
  const t = await turn(s.id, {
    text: "大文件",
    attachments: [{ path: up.body.path }],
  });
  expect(t.ack).toMatchObject({ ok: true });
  expect(userText(t.requests[0] as Record<string, unknown>)).toContain(
    "(text/plain, 2 MB)",
  );
  // 非图片没有 base64；请求体与 2 MiB 原文相比可忽略
  expect(JSON.stringify(t.requests[0]).length).toBeLessThan(300_000);
});

test("图片附件：模型不支持图片输入时按现有语义拒绝，不发起模型调用", async () => {
  const s = await newSession();
  const up = await upload(s.id, "p.png", PNG);
  plan = ["不应发生"];
  const from = stub.requests.length;
  const t = await turn(s.id, {
    text: "看图",
    attachments: [{ path: up.body.path }],
  });
  expect(t.ack).toMatchObject({ ok: false, error: { code: "bad_request" } });
  expect(t.ack.error?.message).toContain("不支持图片输入");
  expect(stub.requests.length).toBe(from);
});

test("图片附件：支持图片的模型收到 ImageInput，标记行与投影为 image/*", async () => {
  const s = await newSession();
  await setCompression();
  const config = await ok("GET", `/api/v1/sessions/${s.id}/config`);
  await ok("PATCH", `/api/v1/sessions/${s.id}/config`, {
    baseRev: config.rev,
    patch: {
      model: {
        mode: "explicit",
        provider: providerId,
        model: "mi",
        reasoning: "off",
      },
    },
  });
  const up = await upload(s.id, "p.png", PNG);
  plan = ["看到了"];
  const t = await turn(s.id, {
    text: "看图",
    attachments: [{ path: up.body.path }],
  });
  expect(t.ack).toMatchObject({ ok: true });
  const body = t.requests[0] as Record<string, unknown>;
  // SDK 把图片序列化成 data URL（base64）交给模型
  expect(JSON.stringify(userContent(body))).toContain("data:image/png;base64,");
  expect(userText(body)).toContain(`(image/png, ${PNG.length} B)`);
  expect(userMessageFrame(t)?.data.attachments).toEqual([
    {
      name: "p.png",
      mime: "image/png",
      sizeText: `${PNG.length} B`,
      path: up.body.path,
    },
  ]);
});

test("图片压缩：按设置参数压缩，交给模型的是压缩后的数据；改设置后下一条即生效", async () => {
  const s = await newSession();
  await useImageModel(s.id);
  const cfg = {
    enabled: true,
    maxWidth: 512,
    maxHeight: 400,
    maxBytes: 200_000,
    jpegQuality: 60,
  };
  await setCompression(cfg);
  resizeResult = {
    data: COMPRESSED_PNG.toString("base64"),
    mimeType: "image/png",
    originalWidth: 4000,
    originalHeight: 3000,
    width: 512,
    height: 384,
    wasResized: true,
  };
  const up = await upload(s.id, "big.png", PNG);
  plan = ["看到了"];
  const t = await turn(s.id, {
    text: "看图",
    attachments: [{ path: up.body.path }],
  });
  expect(t.ack).toMatchObject({ ok: true });
  // 压缩收到的是磁盘上的原图字节与 mime，选项来自设置
  expect(resizeCalls).toHaveLength(1);
  expect(Buffer.from(resizeCalls[0]?.bytes as Uint8Array).equals(PNG)).toBe(
    true,
  );
  expect(resizeCalls[0]?.mime).toBe("image/png");
  expect(resizeCalls[0]?.options).toEqual({
    maxWidth: 512,
    maxHeight: 400,
    maxBytes: 200_000,
    jpegQuality: 60,
  });
  // 模型请求里是压缩后的 base64（不是原图），标记行仍按原文件大小
  const content = JSON.stringify(
    userContent(t.requests[0] as Record<string, unknown>),
  );
  expect(content).toContain(
    `data:image/png;base64,${COMPRESSED_PNG.toString("base64")}`,
  );
  expect(content).not.toContain(
    `data:image/png;base64,${PNG.toString("base64")}`,
  );

  // 保存新设置后，下一次发消息立刻用新参数
  await setCompression({ ...cfg, maxWidth: 800, jpegQuality: 40 });
  plan = ["再看到了"];
  const t2 = await turn(s.id, {
    text: "再看",
    attachments: [{ path: up.body.path }],
  });
  expect(t2.ack).toMatchObject({ ok: true });
  expect(resizeCalls).toHaveLength(2);
  expect(resizeCalls[1]?.options).toEqual({
    maxWidth: 800,
    maxHeight: 400,
    maxBytes: 200_000,
    jpegQuality: 40,
  });
});

test("图片压缩关闭或压缩失败：不拦截消息，回退原图发送", async () => {
  const s = await newSession();
  await useImageModel(s.id);
  const up = await upload(s.id, "p.png", PNG);
  const original = `data:image/png;base64,${PNG.toString("base64")}`;

  // 关闭压缩：不调用压缩实现，原图 base64 发出
  await setCompression({ ...PI_IMAGE_COMPRESSION, enabled: false });
  plan = ["看到了"];
  const off = await turn(s.id, {
    text: "关掉压缩",
    attachments: [{ path: up.body.path }],
  });
  expect(off.ack).toMatchObject({ ok: true });
  expect(resizeCalls).toHaveLength(0);
  expect(
    JSON.stringify(userContent(off.requests[0] as Record<string, unknown>)),
  ).toContain(original);

  // 压缩失败（resizeImage 返回 null）：同样回退原图，消息照常发出
  await setCompression();
  resizeResult = null;
  plan = ["也看到了"];
  const failed = await turn(s.id, {
    text: "压不动",
    attachments: [{ path: up.body.path }],
  });
  expect(failed.ack).toMatchObject({ ok: true });
  expect(resizeCalls).toHaveLength(1);
  expect(
    JSON.stringify(userContent(failed.requests[0] as Record<string, unknown>)),
  ).toContain(original);
});

test("GIF 附件：只按文件路径引用，不内嵌成图片模态", async () => {
  const s = await newSession();
  await setCompression();
  const up = await upload(s.id, "anim.gif", GIF);
  expect(up.body.mime).toBe("image/gif");
  plan = ["收到"];
  const t = await turn(s.id, {
    text: "看动图",
    attachments: [{ path: up.body.path }],
  });
  expect(t.ack).toMatchObject({ ok: true });
  const body = t.requests[0] as Record<string, unknown>;
  expect(userText(body)).toContain(`(image/gif, ${GIF.length} B)`);
  // 不应出现 data URL / base64 图片块
  expect(JSON.stringify(userContent(body))).not.toContain("data:image");
  expect(userMessageFrame(t)?.data.attachments).toEqual([
    {
      name: "anim.gif",
      mime: "image/gif",
      sizeText: `${GIF.length} B`,
      path: up.body.path,
    },
  ]);
});

test("权限围栏：附件区的文件直接寻址就能读写，越界与命令类按各自规则判", async () => {
  const s = await newSession();
  const up = await upload(s.id, "note.txt", Buffer.from("ATTACHED-CONTENT\n"));
  const dir = path.posix.dirname(up.body.path);
  const at = (p: string) => ({
    host: "attachment",
    path: p.replace(/^\./, ""),
  });

  // 读取类工具：附件区的地址直接可用；越界地址在解析处被拒（不弹审批）。
  plan = [
    {
      tools: [
        { tool: "read", args: at(up.body.path) },
        { tool: "read", args: { host: "attachment", path: "/../etc/passwd" } },
        { tool: "ls", args: at(dir) },
        { tool: "grep", args: { ...at(dir), pattern: "ATTACHED" } },
        { tool: "find", args: { ...at(dir), pattern: "*.txt" } },
      ],
    },
    "读完了",
  ];
  const readTurn = await turn(s.id, { text: "读读看" });
  expect(readTurn.approvals).toEqual([]);
  const readResults = toolResults(readTurn.requests[1] ?? {}).slice(-5);
  expect(readResults[0]).toContain("ATTACHED-CONTENT");
  expect(readResults[1]).toContain("must stay inside it");
  expect(readResults[2]).toContain("note.txt");
  expect(readResults[3]).toContain("ATTACHED");
  expect(readResults[4]).toContain("note.txt");

  // 越界写在解析处被拒；附件区只读，edit 也拒不执行。
  plan = [
    {
      tools: [
        {
          tool: "write",
          args: { host: "attachment", path: "/../evil.txt", content: "x" },
        },
        {
          tool: "edit",
          args: {
            ...at(up.body.path),
            edits: [{ oldText: "ATTACHED", newText: "EDITED" }],
          },
        },
      ],
    },
    "改完了",
  ];
  const actTurn = await turn(s.id, { text: "试试" });
  expect(actTurn.approvals).toEqual([]);
  const results = toolResults(actTurn.requests[1] ?? {}).slice(-2);
  expect(results[0]).toContain("must stay inside it");
  expect(existsSync("/etc/evil.txt")).toBe(false);
  expect(results[1]).toContain("read-only");

  // 附件内容没被改：再读一次确认
  plan = [{ tool: "read", args: at(up.body.path) }, "读完"];
  const reread = await turn(s.id, { text: "再读" });
  expect(toolResults(reread.requests[1] ?? {}).slice(-1)[0]).toContain(
    "ATTACHED-CONTENT",
  );
});

test("权限围栏：附件区只读，敏感文件名也不拦读取", async () => {
  const s = await newSession();
  const up = await upload(s.id, ".env", Buffer.from("SECRET=1\n"));

  // 写被拒（只读），且不弹审批
  plan = [
    {
      tool: "write",
      args: { host: "attachment", path: "/.env", content: "X=1\n" },
    },
    "写不了",
  ];
  const written = await turn(s.id, { text: "写配置" });
  expect(written.approvals).toEqual([]);
  expect(toolResults(written.requests[1] ?? {}).join("\n")).toContain(
    "read-only",
  );

  plan = [
    {
      tool: "read",
      args: { host: "attachment", path: up.body.path.replace(/^\./, "") },
    },
    "读好",
  ];
  const read = await turn(s.id, { text: "读配置" });
  expect(read.approvals).toEqual([]);
  expect(toolResults(read.requests[1] ?? {}).join("\n")).toContain("SECRET=1");
});

test("用 transfer_files 把用户附件复制进工作目录（两端都是地址）", async () => {
  const s = await newSession();
  const up = await upload(s.id, "moved.txt", Buffer.from("MOVE-ME\n"));
  plan = [
    {
      tool: "transfer_files",
      args: {
        from_host: "attachment",
        from: up.body.path.replace(/^\./, ""),
        to_host: "local",
        to: path.join(startDir, "moved-out.txt"),
      },
    },
    "完毕",
  ];
  const t = await turn(s.id, { text: "传出去" });
  expect(t.approvals).toEqual([]);
  expect(toolResults(t.requests[1] ?? {}).join("\n")).toContain(
    "Transferred 1 file(s)",
  );
  expect(existsSync(path.join(startDir, "moved-out.txt"))).toBe(true);
  expect(readFileSync(path.join(startDir, "moved-out.txt"), "utf8")).toBe(
    "MOVE-ME\n",
  );
});

test("附件区按工作区存放：同一工作区的两个会话看到同一块，分叉会话能读旧附件", async () => {
  const a = await newSession();
  // 同一主目录的第二个会话：池给它安排到同一个工作区
  const b = await newSession();
  const shared = await ok("GET", "/api/v1/workspaces");
  expect(
    shared.workspaces.filter(
      (w: { sessionCount: number }) => w.sessionCount > 0,
    ),
  ).toHaveLength(1);

  const up = await upload(a.id, "shared.txt", Buffer.from("SHARED\n"));
  // 另一个会话按会话 id 的接口读到同一份
  const seen = await fetch(
    `${http}/api/v1/sessions/${b.id}/attachments/content?path=${encodeURIComponent(up.body.path)}`,
  );
  expect(seen.status).toBe(200);
  expect(await seen.text()).toBe("SHARED\n");

  // 分叉会话读得到分叉之前的附件：新会话自己发一条读附件的调用
  plan = ["记下了"];
  await turn(a.id, { text: "记一下" });
  const tree = await ok("GET", `/api/v1/sessions/${a.id}/tree`);
  const entryId = tree.leafId as string;
  const forked = await ok("POST", `/api/v1/sessions/${a.id}/fork`, {
    entryId,
  });
  plan = [
    {
      tool: "read",
      args: {
        host: "attachment",
        path: up.body.path.replace(/^\./, ""),
      },
    },
    "读到了",
  ];
  const t = await turn(forked.id, { text: "读旧附件" });
  expect(t.approvals).toEqual([]);
  expect(toolResults(t.requests[1] ?? {}).join("\n")).toContain("SHARED");
});

test("重启后：隐藏 directory 与会话绑定关系仍在，附件内容照常可读", async () => {
  const s = await newSession();
  const up = await upload(s.id, "persist.txt", Buffer.from("PERSIST"));
  plan = ["记下了"];
  await turn(s.id, { text: "记一下" });

  await server.stop();
  await boot();

  expect((await ok("GET", `/api/v1/sessions/${s.id}`)).id).toBe(s.id);
  const content = await fetch(
    `${http}/api/v1/sessions/${s.id}/attachments/content?path=${encodeURIComponent(up.body.path)}`,
  );
  expect(content.status).toBe(200);
  expect(await content.text()).toBe("PERSIST");

  // 重启后会话从 JSONL 恢复，agent 仍能看到追加的 attachment directory
  plan = [{ tool: "list_directories", args: {} }, "看到了"];
  const t = await turn(s.id, { text: "看看目录" });
  expect(toolResults(t.requests[1] ?? {}).join("\n")).toContain("attachment");
});
