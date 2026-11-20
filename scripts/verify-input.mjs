// 用户输入统一带附件（文字 + 图片 / 文件）的真机检查：起真实 Server（临时数据目录）+ 假模型 + 无头 Chromium。
//  1) 提问回答：模型 ask_user 弹出自由输入卡，卡里有富输入；传一张图并提交，模型下一轮的请求里有这张图
//  2) 目标：/goal 带一张图，只有第一轮请求带图，之后每轮只带 [attach_file] 路径；卡片注明附件名；右栏目标块列出附件
//  3) 排队：agent 在跑时排的一条消息，编辑里加一张图并保存，轮到它时请求里带图
//  4) 回退：POST /navigate 回填的 editor 里文字不含标记行、附件单列
//  5) 审批：「拒绝并说明」写一句理由，模型收到的拒绝原因里带「用户补充」；一次点击的拒绝与批准不受影响
//  6) 提问带选项时输入框始终在：写了字再点选项 = 选项 + 补充；不点选项直接提交文字 = 自己的话；模型收到的结果文字能区分
//  7) 并行的两个提问合成一张卡：卡头「1 / 2」来回切换，答完一个切换器消失、显示剩下的
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-input.mjs [--shots 目录]
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeModel } from "./lib/fake-model.mjs";
import { chromium } from "./lib/playwright.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`,
  );
};

mkdirSync(join(root, "tmp"), { recursive: true });
const base = mkdtempSync(join(root, "tmp", "input-"));
const work = `${realpathSync(base)}/work`;
mkdirSync(work, { recursive: true });
// 临时 HOME：Server 读 <HOME>/.pi/agent 与 <HOME>/.ys，不碰真实的
const home = join(base, "home");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });

// 一张 1x1 的 PNG（要真的图片字节：服务端按字节识别类型并压缩）
const PNG = join(base, "dot.png");
writeFileSync(
  PNG,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

// 请求体里图片块的个数（OpenAI 兼容格式里图片是 image_url 块）
const images = (req) =>
  (JSON.stringify(req?.body.messages ?? []).match(/"type":"image_url"/g) ?? [])
    .length;
const bodyText = (req) => JSON.stringify(req?.body.messages ?? []);

// 取对话里最近一条目标消息给的 goal_id 与 revision
const goalRefs = (messages) => {
  for (const m of [...messages].reverse()) {
    const text =
      typeof m.content === "string"
        ? m.content
        : (m.content ?? []).map((p) => p.text ?? "").join("");
    const hit = /goal_id: (\S+), revision: (\d+)/.exec(text);
    if (hit) return { goal_id: hit[1], revision: Number(hit[2]) };
  }
  throw new Error("对话里没有目标消息");
};

const SLOW = "慢".repeat(160); // 8 字一块、每块 150ms：流式约 3 秒，期间可以排队

const fake = await startFakeModel(
  [
    // 1) 提问回答
    { tools: [{ name: "ask_user", args: { question: "把参考图给我 QIMG" } }] }, //  1
    { text: "收到答复 AFIN" }, //                                              2
    // 2) 目标：第一轮只说话，第二轮宣布完成
    { text: "目标第一轮 G1" }, //                                              3
    {
      tools: [
        {
          name: "update_goal",
          args: (m) => ({ ...goalRefs(m), action: "complete" }),
        },
      ],
    }, //                                                                     4
    { text: "目标完成 GDONE" }, //                                            5
    // 3) 排队：第一条慢，第二条（排队、编辑里加图）轮到时只回一句
    { text: SLOW, delay: 150 }, //                                            6
    { text: "排队那条收到 Q2DONE" }, //                                       7
    // 5) 审批被拒（带理由）
    { tools: [{ name: "bash", args: { command: "mkdir -p out-deny" } }] }, //  8
    { text: "拒绝后收到 DENYDONE" }, //                                        9
    // 6) 带选项的提问：点选项 + 补充 / 不点选项自己写
    {
      tools: [
        {
          name: "ask_user",
          args: { question: "选哪个 QOPT1", options: ["甲", "乙"] },
        },
      ],
    }, //                                                                     10
    { text: "第一问收到 ASKDONE1" }, //                                         11
    {
      tools: [
        {
          name: "ask_user",
          args: { question: "再选哪个 QOPT2", options: ["甲", "乙"] },
        },
      ],
    }, //                                                                     12
    { text: "第二问收到 ASKDONE2" }, //                                        13
    // 7) 并行的两个 ask_user：合成一张卡，左右切换
    {
      tools: [
        { name: "ask_user", args: { question: "并行甲 QPA" } },
        { name: "ask_user", args: { question: "并行乙 QPB" } },
      ],
    }, //                                                                     14
    { text: "并行答完 PARDONE" }, //                                          15
  ],
  { delay: 0 },
);

const port = 18500 + Math.floor(Math.random() * 90);
const origin = `http://127.0.0.1:${port}`;
const proc = spawn(
  "node",
  [
    join(root, "packages/server/dist/bin.js"),
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--data-dir",
    join(base, "data"),
  ],
  { stdio: "ignore", cwd: work, env: { ...process.env, HOME: home } },
);
const api = async (method, path, body) => {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};

const problems = [];

async function main() {
  let up = false;
  for (let i = 0; i < 600 && !up; i++) {
    try {
      up = (await fetch(`${origin}/healthz`)).ok;
    } catch {}
    if (!up) await sleep(100);
  }
  if (!up) throw new Error("Server 60 秒内没有起来（机器负载高时启动会很慢）");
  const registered = await api("POST", "/providers", {
    name: "假模型",
    slug: "fake",
    api: "openai-completions",
    baseUrl: fake.baseUrl,
    apiKey: "x",
    models: [
      {
        id: "fake",
        name: "fake",
        reasoning: true,
        levels: ["off", "low", "high"],
        // 要能收图：不然服务端会拒绝带图片的内容
        input: ["text", "image"],
        ctx: 32000,
        out: 4096,
        source: "manual",
      },
    ],
  });
  if (registered?.error)
    throw new Error(`注册假模型失败：${JSON.stringify(registered)}`);
  await api("PUT", "/defaults", { permissionTier: "full" });

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1600, height: 900 } })
    ).newPage();
    page.on("pageerror", (e) =>
      problems.push(`pageerror ${e.message.split("\n")[0]}`),
    );
    page.on("console", (m) => {
      if (m.type() === "error")
        problems.push(`console.error ${m.text().slice(0, 140)}`);
    });
    const shot = (n) =>
      SHOTS ? page.screenshot({ path: join(SHOTS, `${n}.png`) }) : null;

    await page.goto(origin);
    await page.getByRole("button", { name: "新建工作区" }).first().click();
    await page.getByLabel("目录路径").fill(work);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("log", { name: "对话记录" }).waitFor();
    await sleep(500);

    const composer = page.locator("form[data-composer]");
    const box = composer.locator("textarea");
    const say = async (text, mark) => {
      await box.fill(text);
      await box.press("Enter");
      if (!mark) return;
      try {
        await page.getByText(mark).first().waitFor({ timeout: 60000 });
      } catch (e) {
        await shot(`fail-${mark}`);
        throw e;
      }
      await sleep(500);
    };
    // 在某个容器里选一张图，等它上传完成（附件条里出现、没有上传中的标记）
    const attach = async (scope) => {
      await scope.locator('[data-file-input=""]').setInputFiles(PNG);
      await scope.locator("[data-attach-row] li").first().waitFor();
      await page
        .locator("[data-attach-row] [aria-busy='true']")
        .waitFor({ state: "detached", timeout: 15000 })
        .catch(() => {});
      await sleep(500);
    };
    const mains = () => fake.requests.filter((r) => r.main);

    // ── 1) 提问回答带图 ──
    await say("问我一个问题", null);
    const card = page.locator("section[aria-label='提问']");
    await card.waitFor({ timeout: 60000 });
    check(
      "自由输入的提问卡里是富输入（文字框 + 上传文件）",
      (await card.locator("[data-rich-input]").count()) === 1 &&
        (await card.getByRole("button", { name: "上传文件" }).count()) === 1,
    );
    await attach(card);
    await shot("1-question-attached");
    await card.getByRole("textbox", { name: "回答" }).fill("就这张");
    await card.getByRole("button", { name: "提交" }).click();
    await page.getByText("AFIN").first().waitFor({ timeout: 60000 });
    const afterAnswer = mains().at(1);
    check(
      "模型下一轮的请求里有这张图，工具结果里有附件标记行",
      images(afterAnswer) === 1 &&
        bodyText(afterAnswer).includes("[attach_file]") &&
        bodyText(afterAnswer).includes("就这张"),
      `images=${images(afterAnswer)}`,
    );
    const settled = await page
      .locator("section.ch-settled[aria-label='提问']")
      .textContent();
    check(
      "答完后收成一行，写出回答与附件名",
      (settled ?? "").includes("就这张") && (settled ?? "").includes("dot.png"),
      settled ?? "",
    );

    // ── 2) 目标带图：只有第一轮带图，之后每轮只带路径 ──
    await attach(composer);
    await box.fill("/goal 按参考图做 GOALIMG");
    await box.press("Enter");
    await page.getByText("GDONE").first().waitFor({ timeout: 60000 });
    await sleep(500);
    // 对话历史里已有第 1 步那张图：基线 +1 是目标第一轮带进来的，之后每轮请求里的图片总数不再增加
    const gReqs = mains().slice(2, 5);
    const baseline = images(mains().at(1));
    check(
      "第一轮请求多带这张图；后面每轮不再带新图，但目标消息里还有路径",
      images(gReqs[0]) === baseline + 1 &&
        images(gReqs[1]) === baseline + 1 &&
        images(gReqs[2]) === baseline + 1 &&
        /Goal round 2[\s\S]*\[attach_file\]/.test(bodyText(gReqs[1])),
      `images ${baseline} → ${gReqs.map(images).join("/")}`,
    );
    const setCard = (
      await page
        .locator("[data-kind='goal-set']")
        .evaluateAll((els) => els.map((e) => e.textContent ?? ""))
    ).at(-1);
    check(
      "对话流里的目标卡片注明附件名",
      (setCard ?? "").includes("附件 dot.png"),
      setCard ?? "",
    );
    check(
      "发出后草稿里的附件清空",
      (await composer.locator("[data-attach-row]").count()) === 0,
    );
    await shot("2-goal");

    // ── 3) 排队消息：编辑里加一张图 ──
    await say("先做个慢的 QSLOW", null);
    await page
      .getByRole("button", { name: "停止运行" })
      .waitFor({ timeout: 30000 });
    await say("排队的一条 Q2", null);
    const queue = page.locator("[data-queue]");
    await queue.waitFor({ timeout: 15000 });
    await queue.getByRole("button", { name: "编辑" }).click();
    const edit = queue.locator("[data-rich-input]");
    await edit.waitFor({ timeout: 15000 });
    await attach(edit);
    await shot("3-queue-edit");
    await edit.getByRole("button", { name: "保存" }).click();
    await page.getByText("Q2DONE").first().waitFor({ timeout: 60000 });
    const q2 = mains().at(6);
    check(
      "排队的那条轮到时，请求里带编辑时加的图，文字里没有重复的标记行",
      images(q2) === images(mains().at(5)) + 1 &&
        (bodyText(q2).match(/排队的一条 Q2/g) ?? []).length === 1,
      `images ${images(mains().at(5))} → ${images(q2)}`,
    );

    // ── 4) 回退回填：文字与附件分开 ──
    const sessions = await api("GET", "/sessions");
    const sid = (sessions.sessions ?? sessions)[0]?.id;
    const users = await api("GET", `/sessions/${sid}/user-messages`);
    const list = users.messages ?? users.entries ?? users;
    const target = list.find((m) => String(m.text).includes("排队的一条 Q2"));
    const nav = target
      ? await api("POST", `/sessions/${sid}/navigate`, {
          entryId: target.entryId ?? target.id,
        })
      : null;
    check(
      "回退到那条：editor 的文字不含标记行，附件单列",
      nav?.editor?.text === "排队的一条 Q2" &&
        nav.editor.attachments?.length === 1 &&
        nav.editor.attachments[0].name === "dot.png",
      JSON.stringify(nav?.editor ?? nav),
    );

    // ── 5) 审批：拒绝并说明 ──
    await api("PUT", "/defaults", { permissionTier: "rules" });
    await say("跑个要审批的命令 QDENY", null);
    const approve = page.locator("section[aria-label='审批']").first();
    await approve.waitFor({ timeout: 60000 });
    const approveButtons = await approve
      .locator("button")
      .evaluateAll((els) => els.map((e) => e.textContent));
    check(
      "审批卡：批准 / 拒绝一次点击，另有「拒绝并说明」",
      approveButtons.includes("批准") &&
        approveButtons.includes("拒绝") &&
        approveButtons.includes("拒绝并说明"),
      approveButtons.join("|"),
    );
    await approve.getByRole("button", { name: "拒绝并说明" }).click();
    // 等一下再动输入框：Playwright 的 fill 会自己把元素滚进视口，抢在对话流贴底之前就会把「贴底」弄丢
    await sleep(300);
    const reasonBox = approve.getByRole("textbox", { name: "拒绝的理由" });
    await reasonBox.fill("别动生产目录");
    await sleep(600);
    // 展开输入行后卡片变高：对话流要跟着，输入行不能被下面的输入卡盖住
    const visible = await page.evaluate(() => {
      const ta = document.querySelector("[aria-label='拒绝的理由']");
      const dock = document.querySelector("[data-chat-dock]");
      const a = ta?.getBoundingClientRect();
      const b = dock?.getBoundingClientRect();
      const st = document.querySelector("[data-chat-stream]");
      return {
        taBottom: a?.bottom ?? 0,
        dockTop: b?.top ?? 0,
        scrollTop: st?.scrollTop,
        scrollHeight: st?.scrollHeight,
        clientHeight: st?.clientHeight,
        away: [...document.querySelectorAll("button")].some(
          (b) => b.textContent === "回到底部",
        ),
      };
    });
    check(
      "展开「拒绝并说明」后输入行在输入卡之上、没被盖住",
      visible.taBottom <= visible.dockTop + 1,
      JSON.stringify(visible),
    );
    await shot("5-approval-explain");
    await approve
      .getByRole("button", { name: "拒绝", exact: true })
      .last()
      .click();
    await page.getByText("DENYDONE").first().waitFor({ timeout: 60000 });
    const deniedBody = bodyText(mains().at(8));
    check(
      "模型收到的拒绝原因里带「用户补充：别动生产目录」",
      deniedBody.includes("用户补充：别动生产目录"),
    );
    const settledLine = await page
      .locator("section.ch-settled[data-state='denied']")
      .first()
      .textContent();
    check(
      "审批收成一行，写明已拒绝与理由",
      (settledLine ?? "").includes("已拒绝") &&
        (settledLine ?? "").includes("理由：别动生产目录"),
      settledLine ?? "",
    );
    await api("PUT", "/defaults", { permissionTier: "full" });

    // ── 6) 带选项的提问：输入框始终在 ──
    await say("再问我一个带选项的 QOPT", null);
    // 只认待答的那张：前面已答的提问也是 aria-label=提问，会被 last() 抢先命中
    const pendingAsk = page.locator(
      "section[aria-label='提问'][data-state='pending']",
    );
    const ask1 = pendingAsk;
    await ask1.waitFor({ timeout: 60000 });
    check(
      "带选项的提问卡里也有输入框",
      (await ask1.locator("[data-rich-input]").count()) === 1 &&
        (await ask1.getByRole("button", { name: "甲" }).count()) === 1,
    );
    await ask1.getByRole("textbox", { name: "回答" }).fill("但是要保守一点");
    await ask1.getByRole("button", { name: "甲" }).click();
    await page.getByText("ASKDONE1").first().waitFor({ timeout: 60000 });
    const both = bodyText(mains().at(10));
    check(
      "写了字再点选项：模型收到「选了甲」和「还写了…」",
      both.includes("The user selected: 甲") &&
        both.includes("The user also wrote: 但是要保守一点"),
    );
    await say("再问一个 QOPT2", null);
    const ask2 = pendingAsk;
    await ask2.waitFor({ timeout: 60000 });
    await ask2.getByRole("textbox", { name: "回答" }).fill("都不要，换个思路");
    await ask2.getByRole("button", { name: "提交" }).click();
    await page.getByText("ASKDONE2").first().waitFor({ timeout: 60000 });
    const own = bodyText(mains().at(12));
    check(
      "不点选项直接写：模型收到「没选列出的选项，回复…」",
      own.includes(
        "The user did not pick a listed option and replied: 都不要，换个思路",
      ),
    );
    await shot("6-ask-own-words");

    // ── 7) 并行的两个提问：一张卡，「‹ 1 / 2 ›」来回切换 ──
    await say("并行问我两个 QPAR", null);
    const pager = page.getByRole("group", { name: "待答的弹窗" });
    try {
      await pager.waitFor({ timeout: 20000 });
    } catch (e) {
      await shot("fail-pager");
      console.log(
        "待答卡：",
        JSON.stringify(
          await page
            .locator("section[aria-label='提问']")
            .evaluateAll((els) =>
              els.map((x) => [
                x.getAttribute("data-state"),
                x.parentElement?.hidden,
                (x.textContent ?? "").slice(0, 30),
              ]),
            ),
        ),
      );
      throw e;
    }
    const visibleAsks = page.locator(
      "section[aria-label='提问'][data-state='pending']:visible",
    );
    check(
      "两个提问同时待答：只显示一张卡，卡头有「1 / 2」",
      (await visibleAsks.count()) === 1 &&
        (await pager.textContent())?.includes("1 / 2"),
      await pager.textContent(),
    );
    const first = await visibleAsks.first().textContent();
    await shot("7-pager-1");
    await page.getByRole("button", { name: "下一个" }).click();
    const second = await visibleAsks.first().textContent();
    check(
      "点「下一个」：换成另一个问题，计数 2 / 2；首尾相接",
      first !== second &&
        (await pager.textContent())?.includes("2 / 2") &&
        (first ?? "").includes("并行甲") !== (second ?? "").includes("并行甲"),
      `${first?.slice(0, 20)} → ${second?.slice(0, 20)}`,
    );
    await shot("7-pager-2");
    // 先答当前这个（乙）：卡片落成一行，只剩一个待答，切换器消失
    await visibleAsks
      .first()
      .getByRole("textbox", { name: "回答" })
      .fill("乙的答案");
    await visibleAsks.first().getByRole("button", { name: "提交" }).click();
    await pager.waitFor({ state: "detached", timeout: 15000 });
    check(
      "答完一个：切换器消失，显示剩下的那一个",
      (await visibleAsks.count()) === 1 &&
        ((await visibleAsks.first().textContent()) ?? "").includes("并行甲"),
    );
    await visibleAsks
      .first()
      .getByRole("textbox", { name: "回答" })
      .fill("甲的答案");
    await visibleAsks.first().getByRole("button", { name: "提交" }).click();
    await page.getByText("PARDONE").first().waitFor({ timeout: 60000 });
    const parBody = bodyText(mains().at(14));
    check(
      "模型收到两个答案，各对各",
      parBody.includes("甲的答案") && parBody.includes("乙的答案"),
    );
  } finally {
    await browser.close();
  }
}

let crashed = null;
try {
  await main();
} catch (e) {
  crashed = e;
} finally {
  proc.kill("SIGTERM");
  await fake.close();
  // 机器上全局 pi 扩展的 fs.watch 句柄会让优雅退出一直挂着，等 5 秒不退就强杀
  await Promise.race([new Promise((r) => proc.on("exit", r)), sleep(5000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}

const uniq = [...new Set(problems)];
check("全程没有控制台报错", uniq.length === 0, uniq.slice(0, 5).join(" | "));
if (crashed)
  console.log(
    `脚本异常：${String(crashed.message).split("\n").slice(0, 4).join(" | ")}`,
  );
const bad = results.filter((r) => !r).length + (crashed ? 1 : 0);
console.log(
  bad
    ? `\n未通过：${bad} 项`
    : `\nPASS  用户输入带附件：${results.length}/${results.length} 项通过`,
);
process.exit(bad ? 1 : 0);
