import { expect, test } from "vitest";
import type { PromptResult, PromptSpec } from "../../session/prompts.js";
import {
  answerVerdict,
  createApproveDownload,
  createApproveOpen,
  createApproveUpload,
} from "./approve.js";

function setup(opts: { auto?: boolean; answer?: PromptResult }) {
  const asked: PromptSpec[] = [];
  const remembered: string[] = [];
  const audits: unknown[] = [];
  const approve = createApproveOpen({
    auto: () => opts.auto ?? false,
    ask: async (spec) => {
      asked.push(spec);
      return opts.answer ?? { outcome: "cancelled" };
    },
    remember: (o) => void remembered.push(o),
    audit: (r) => void audits.push(r),
  });
  return { approve, asked, remembered, audits };
}

const args = { origin: "https://example.com", reason: "需要审批站点" };

test("完全允许档或规则放行：不弹卡片，直接记住并通过", async () => {
  const s = setup({ auto: true });
  expect(await s.approve(args)).toEqual({ allowed: true });
  expect(s.asked).toEqual([]);
  expect(s.remembered).toEqual(["https://example.com"]);
  expect(s.audits).toEqual([
    { decision: "allow", by: "tier", origin: "https://example.com" },
  ]);
});

test("用户通过：卡片带站点与原因，通过后记住", async () => {
  const s = setup({ answer: { outcome: "answered", optionId: "allow" } });
  expect(await s.approve(args)).toEqual({ allowed: true });
  expect(s.asked).toHaveLength(1);
  expect(s.asked[0]?.source).toBe("approval");
  expect(s.asked[0]?.title).toBe("允许 agent 访问这个站点？");
  expect(s.asked[0]?.body).toBe(
    "https://example.com\n\n需要审批站点\n\n通过后，这个工作区里的 agent 之后可以直接访问该站点；页面内容来自网络，不可信。",
  );
  expect(s.asked[0]?.options?.map((o) => o.id)).toEqual(["allow", "deny"]);
  expect(s.remembered).toEqual(["https://example.com"]);
  expect(s.audits).toEqual([
    { decision: "allow", by: "user", origin: "https://example.com" },
  ]);
});

test("服务：卡片换标题与正文，去掉不可信的提醒；auto 档直接过并记住", async () => {
  const serviceArgs = {
    origin: "http://server.localhost:5173",
    reason: "agent 要访问 server:5173 上的服务（这个端口没在命令输出里出现过）",
    service: true,
  };
  const s = setup({ answer: { outcome: "answered", optionId: "allow" } });
  expect(await s.approve(serviceArgs)).toEqual({ allowed: true });
  expect(s.asked[0]?.title).toBe("允许 agent 访问这个服务？");
  expect(s.asked[0]?.body).toBe(
    "http://server.localhost:5173\n\nagent 要访问 server:5173 上的服务（这个端口没在命令输出里出现过）\n\n通过后，这个工作区里的 agent 之后可以直接访问这个端口。",
  );
  expect(s.asked[0]?.body).not.toContain("不可信");
  // 来源就是虚拟主机名，与外部站点同一张批准表
  expect(s.remembered).toEqual(["http://server.localhost:5173"]);

  const auto = setup({ auto: true });
  expect(await auto.approve(serviceArgs)).toEqual({ allowed: true });
  expect(auto.asked).toEqual([]);
  expect(auto.remembered).toEqual(["http://server.localhost:5173"]);
  expect(auto.audits).toEqual([
    { decision: "allow", by: "tier", origin: "http://server.localhost:5173" },
  ]);
});

test.each([
  [{ outcome: "answered", optionId: "deny" } as PromptResult, "user"],
  [{ outcome: "timeout" } as PromptResult, "timeout"],
  [{ outcome: "cancelled" } as PromptResult, "cancelled"],
])("拒绝 / 超时 / 取消：不通过、不记住（%j）", async (answer, by) => {
  const s = setup({ answer });
  expect(await s.approve(args)).toEqual({ allowed: false, note: "" });
  expect(s.remembered).toEqual([]);
  expect(s.audits).toEqual([
    { decision: "deny", by, origin: "https://example.com" },
  ]);
});

test("站点：被拒时把用户写的理由带回来，审计不记理由", async () => {
  const s = setup({
    answer: { outcome: "answered", optionId: "deny", text: "这个站点别开" },
  });
  expect(await s.approve(args)).toEqual({
    allowed: false,
    note: "这个站点别开",
  });
  expect(s.audits).toEqual([
    { decision: "deny", by: "user", origin: "https://example.com" },
  ]);
  expect(JSON.stringify(s.audits)).not.toContain("这个站点别开");
  // input: "text"：卡片上有输入框（拒绝理由）
  expect(s.asked[0]?.input).toBe("text");
});

test("answerVerdict：只有选 allow 算通过；其余（含只写字）都是被拒并把话带上", () => {
  expect(answerVerdict({ outcome: "answered", optionId: "allow" })).toEqual({
    allowed: true,
  });
  // allow 带文字也不看文字
  expect(
    answerVerdict({ outcome: "answered", optionId: "allow", text: "随便" }),
  ).toEqual({ allowed: true });
  expect(answerVerdict({ outcome: "answered", optionId: "deny" })).toEqual({
    allowed: false,
    note: "",
  });
  // 只写字没选选项：拒绝，话就是理由
  expect(answerVerdict({ outcome: "answered", text: "别动" })).toEqual({
    allowed: false,
    note: "别动",
  });
  expect(answerVerdict({ outcome: "timeout" })).toEqual({
    allowed: false,
    note: "",
  });
  expect(answerVerdict({ outcome: "cancelled" })).toEqual({
    allowed: false,
    note: "",
  });
});

// —— 下载审批 ——

function setupDownload(opts: { auto?: boolean; answer?: PromptResult }) {
  const asked: PromptSpec[] = [];
  const audits: unknown[] = [];
  const approveDownload = createApproveDownload({
    auto: () => opts.auto ?? false,
    ask: async (spec) => {
      asked.push(spec);
      return opts.answer ?? { outcome: "cancelled" };
    },
    audit: (r) => void audits.push(r),
  });
  return { approveDownload, asked, audits };
}

const dlArgs = {
  filename: "报表.csv",
  pageUrl: "https://example.com/a",
  fileUrl: "https://example.com/export.csv?token=***",
  executable: false,
};

test("下载：完全允许档不问，直接过并写审计", async () => {
  const s = setupDownload({ auto: true });
  expect(await s.approveDownload(dlArgs)).toEqual({ allowed: true });
  expect(s.asked).toEqual([]);
  expect(s.audits).toEqual([
    {
      decision: "allow",
      by: "tier",
      filename: "报表.csv",
      origin: "https://example.com/a",
    },
  ]);
});

test("下载：卡片有文件名、来源页面与文件地址，选项只有通过 / 拒绝，没有「记住」", async () => {
  const s = setupDownload({
    answer: { outcome: "answered", optionId: "allow" },
  });
  expect(await s.approveDownload(dlArgs)).toEqual({ allowed: true });
  expect(s.asked).toHaveLength(1);
  const spec = s.asked[0];
  expect(spec?.source).toBe("approval");
  expect(spec?.title).toBe("允许 agent 下载这个文件？");
  expect(spec?.body).toBe(
    "文件：报表.csv\n来源页面：https://example.com/a\n文件地址：https://example.com/export.csv?token=***\n\n通过后，文件会存进本会话的附件区（不会自动打开或执行）；下载的内容来自网络，不可信。",
  );
  expect(spec?.options?.map((o) => o.id)).toEqual(["allow", "deny"]);
  expect(spec?.options?.map((o) => o.label)).toEqual(["通过", "拒绝"]);
  expect(JSON.stringify(spec?.options)).not.toContain("记住");
  expect(spec?.detail).toEqual({
    tool: "browser_download",
    summary: "报表.csv",
  });
  expect(s.audits).toEqual([
    {
      decision: "allow",
      by: "user",
      filename: "报表.csv",
      origin: "https://example.com/a",
    },
  ]);
});

test("下载：可执行类文件在正文最前面加警示", async () => {
  const s = setupDownload({
    answer: { outcome: "answered", optionId: "allow" },
  });
  await s.approveDownload({
    ...dlArgs,
    filename: "setup.exe",
    executable: true,
  });
  expect(
    s.asked[0]?.body?.startsWith("⚠ 这是可执行类文件，下载后不要运行它。\n\n"),
  ).toBe(true);
  expect(s.asked[0]?.body).toContain("文件：setup.exe");
});

test.each([
  [{ outcome: "answered", optionId: "deny" } as PromptResult, "user"],
  [{ outcome: "timeout" } as PromptResult, "timeout"],
  [{ outcome: "cancelled" } as PromptResult, "cancelled"],
])("下载：拒绝 / 超时 / 取消都不通过并写审计（%j）", async (answer, by) => {
  const s = setupDownload({ answer });
  expect(await s.approveDownload(dlArgs)).toEqual({ allowed: false, note: "" });
  expect(s.audits).toEqual([
    {
      decision: "deny",
      by,
      filename: "报表.csv",
      origin: "https://example.com/a",
    },
  ]);
});

test("下载：被拒时把用户写的理由带回来，审计不记理由", async () => {
  const s = setupDownload({
    answer: { outcome: "answered", optionId: "deny", text: "这个文件不要" },
  });
  expect(await s.approveDownload(dlArgs)).toEqual({
    allowed: false,
    note: "这个文件不要",
  });
  expect(JSON.stringify(s.audits)).not.toContain("这个文件不要");
  expect(s.asked[0]?.input).toBe("text");
});

// —— 上传审批 ——

function setupUpload(opts: { auto?: boolean; answer?: PromptResult }) {
  const asked: PromptSpec[] = [];
  const audits: unknown[] = [];
  const approveUpload = createApproveUpload({
    auto: () => opts.auto ?? false,
    ask: async (spec) => {
      asked.push(spec);
      return opts.answer ?? { outcome: "cancelled" };
    },
    audit: (r) => void audits.push(r),
  });
  return { approveUpload, asked, audits };
}

const upArgs = {
  origin: "https://example.com",
  pageUrl: "https://example.com/upload?x=1",
  files: [
    { name: "报表.csv", sizeText: "3.3 MB", display: "项目:data/报表.csv" },
    { name: "图.png", sizeText: "12 KB", display: "attachment:./2026/图.png" },
  ],
};

test("上传：完全允许档不问，直接过并写审计（只有文件名）", async () => {
  const s = setupUpload({ auto: true });
  expect(await s.approveUpload(upArgs)).toEqual({ allowed: true });
  expect(s.asked).toEqual([]);
  expect(s.audits).toEqual([
    {
      decision: "allow",
      by: "tier",
      origin: "https://example.com",
      files: ["报表.csv", "图.png"],
    },
  ]);
});

test("上传：卡片写目标站点、页面与每个文件，选项只有通过 / 拒绝，没有「记住」", async () => {
  const s = setupUpload({
    answer: { outcome: "answered", optionId: "allow" },
  });
  expect(await s.approveUpload(upArgs)).toEqual({ allowed: true });
  expect(s.asked).toHaveLength(1);
  const spec = s.asked[0];
  expect(spec?.source).toBe("approval");
  expect(spec?.title).toBe("允许 agent 上传文件？");
  expect(spec?.body).toBe(
    "目标站点：https://example.com\n页面：https://example.com/upload?x=1\n\n文件：\n- 报表.csv（3.3 MB）← 项目:data/报表.csv\n- 图.png（12 KB）← attachment:./2026/图.png\n\n通过后，这些文件会交给该页面里的上传入口；页面内容来自网络，不可信，文件一旦上传就无法收回。",
  );
  expect(spec?.options?.map((o) => o.id)).toEqual(["allow", "deny"]);
  expect(spec?.options?.map((o) => o.label)).toEqual(["通过", "拒绝"]);
  expect(JSON.stringify(spec?.options)).not.toContain("记住");
  expect(spec?.detail).toEqual({
    tool: "browser_upload",
    summary: "2 个文件 → https://example.com",
  });
  expect(s.audits).toEqual([
    {
      decision: "allow",
      by: "user",
      origin: "https://example.com",
      files: ["报表.csv", "图.png"],
    },
  ]);
});

test.each([
  [{ outcome: "answered", optionId: "deny" } as PromptResult, "user"],
  [{ outcome: "timeout" } as PromptResult, "timeout"],
  [{ outcome: "cancelled" } as PromptResult, "cancelled"],
])("上传：拒绝 / 超时 / 取消都不通过并写审计（%j）", async (answer, by) => {
  const s = setupUpload({ answer });
  expect(await s.approveUpload(upArgs)).toEqual({ allowed: false, note: "" });
  expect(s.audits).toEqual([
    {
      decision: "deny",
      by,
      origin: "https://example.com",
      files: ["报表.csv", "图.png"],
    },
  ]);
});

test("上传：被拒时把用户写的理由带回来，审计不记理由", async () => {
  const s = setupUpload({
    answer: { outcome: "answered", optionId: "deny", text: "先别传" },
  });
  expect(await s.approveUpload(upArgs)).toEqual({
    allowed: false,
    note: "先别传",
  });
  expect(JSON.stringify(s.audits)).not.toContain("先别传");
  expect(s.asked[0]?.input).toBe("text");
});
