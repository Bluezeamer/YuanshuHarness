// 浏览器本地状态的真机检查：起真实 Server（临时数据目录）+ 无头 Chromium，不需要真实模型。
//  1) 文件编辑草稿：编辑到一半，切到预览再回来、关掉标签再开、刷新页面都还在，带「已恢复」提示；保存、改回原样后草稿删掉
//  2) 磁盘在草稿期间被改了：恢复草稿后保存走冲突对话框，不静默覆盖
//  3) 敏感文件（.env）不落本地；超过 30 天的草稿启动时清掉
//  4) 视图状态：文件管理器的多选与滚动位置、预览的预览 / 编辑模式与编辑器滚动位置，切走再切回、刷新后还在；关标签清掉记录
//  5) 全程没有控制台报错、没有失败的接口请求
// 前提：已构建 server 与 web（pnpm build），把 packages/web/dist 同步到 packages/server/web，并装好 Chromium（装法见 scripts/lib/playwright.mjs）。
// 用法：node scripts/verify-state.mjs [--shots 目录]
import { execSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const base = mkdtempSync(join(root, "tmp", "state-"));
const work = `${realpathSync(base)}/work`;
const dir = `${work}/proj`;
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "a.txt"), "alpha\n");
writeFileSync(join(dir, "b.txt"), "bravo\n");
writeFileSync(join(dir, "c.txt"), "charlie\n");
writeFileSync(join(dir, "note.md"), "# 笔记\n\n正文\n");
writeFileSync(join(dir, ".env"), "SECRET=1\n");
mkdirSync(join(dir, "many"), { recursive: true });
for (let i = 0; i < 90; i++)
  writeFileSync(join(dir, "many", `f${String(i).padStart(2, "0")}.txt`), "x\n");
writeFileSync(
  join(dir, "long.txt"),
  Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
);
const port = 18200 + Math.floor(Math.random() * 90);
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
  { stdio: "ignore", cwd: work },
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
  await api("POST", "/providers", {
    name: "占位",
    slug: "placeholder",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "x",
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
    ],
  });
  const ws = await api("POST", "/workspaces", {
    name: "状态",
    directories: [{ path: dir }],
  });
  await api("POST", "/sessions", { workspaceId: ws.id });

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.on("pageerror", (e) =>
      problems.push(`pageerror ${e.message.split("\n")[0]}`),
    );
    page.on("console", (m) => {
      if (m.type() === "error")
        problems.push(`console.error ${m.text().slice(0, 140)}`);
    });
    page.on("response", (r) => {
      if (r.url().includes("/api/v1/") && r.status() >= 400)
        problems.push(
          `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`,
        );
    });
    const shot = async (name) => {
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    };

    await page.goto(origin);
    await page.waitForSelector(".sh-app");
    await page.locator(".rl-wh", { hasText: "状态" }).click();
    await page.waitForSelector(".ws-fm-row");
    await sleep(800);

    const row = (name) =>
      page.locator(`.ws-fm-row[data-name="${name}"] .u-lrow-main`);
    const cm = () => page.locator(".ws-pv .cm-content");
    const draftKeys = () =>
      page.evaluate(() =>
        Object.keys(localStorage).filter((k) => k.startsWith("ys.file.draft:")),
      );
    const draftOf = (name) =>
      page.evaluate((full) => {
        const k = Object.keys(localStorage).find(
          (k) =>
            k.startsWith("ys.file.draft:") &&
            k.endsWith(`:${encodeURIComponent(full)}`),
        );
        return k ? JSON.parse(localStorage.getItem(k)) : null;
      }, `${dir}/${name}`);
    const toasts = () =>
      page
        .locator(".u-toast")
        .evaluateAll((els) => els.map((e) => e.textContent));
    const dirtyShown = async () =>
      (await page.locator(".ws-pv-dirty").count()) > 0;
    const open = async (name) => {
      await row(name).dblclick();
      await cm().waitFor();
      await sleep(400);
    };
    const typeAtEnd = async (text) => {
      await cm().click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type(text);
    };
    const closePreview = async (name) => {
      const tab = page.locator(".ws-pn-tab[data-type='preview']", {
        hasText: name,
      });
      await tab.hover();
      await tab.getByRole("button", { name: /^关闭/ }).click();
      await sleep(300);
    };
    const focusFiles = async () => {
      await page.locator(".ws-pn-tab[data-type='files']").first().click();
      await page.waitForSelector(".ws-fm-row");
    };

    // 1) 编辑到一半的草稿
    await open("a.txt");
    check(
      "打开文件：编辑器里是磁盘内容，没有「未保存」",
      (await cm().innerText()).trim() === "alpha" && !(await dirtyShown()),
    );
    await typeAtEnd("草稿一");
    await sleep(700);
    check("打字后标「未保存」", await dirtyShown());
    const d = await draftOf("a.txt");
    check(
      "草稿存进了浏览器本地：带文本与磁盘基线",
      d?.text === "alpha草稿一\n" || d?.text?.includes("草稿一"),
      JSON.stringify(d),
    );
    check(
      "基线是开始编辑时磁盘上的那一版（有 mtime 与 sha256）",
      typeof d?.base?.mtimeMs === "number" &&
        typeof d?.base?.sha256 === "string",
    );
    await shot("state-1-editing");

    // 同一窗格里切到别的标签再回来：窗格只渲染当前标签，编辑器会卸载重建
    await focusFiles();
    await row("c.txt").click();
    await page
      .locator(".ws-pn-tab[data-type='preview']", { hasText: "c.txt" })
      .waitFor();
    await sleep(500);
    await page
      .locator(".ws-pn-tab[data-type='preview']", { hasText: "a.txt" })
      .click();
    await cm().waitFor();
    {
      const toastShown = await page
        .locator(".u-toast", { hasText: "已恢复上次没保存的改动" })
        .waitFor({ timeout: 3000 })
        .then(
          () => true,
          () => false,
        );
      const st = [
        (await cm().innerText()).includes("草稿一"),
        await dirtyShown(),
      ];
      check(
        "同窗格切走再切回：草稿还在、仍标「未保存」、弹出恢复提示",
        st[0] && st[1] && toastShown,
        JSON.stringify([...st, toastShown]),
      );
    }
    await closePreview("c.txt");

    // 关掉标签再开
    await closePreview("a.txt");
    check("关标签没有拦截弹窗", (await page.getByRole("dialog").count()) === 0);
    check("关掉标签后草稿留在本地", (await draftOf("a.txt")) !== null);
    await focusFiles();
    await open("a.txt");
    check(
      "重新打开这个文件：草稿恢复、标「未保存」",
      (await cm().innerText()).includes("草稿一") && (await dirtyShown()),
    );

    // 刷新页面（等布局存盘）
    await sleep(1500);
    await page.reload();
    await page.waitForSelector(".ws-pv .cm-content");
    await sleep(600);
    check(
      "刷新页面：草稿仍在、标「未保存」",
      (await cm().innerText()).includes("草稿一") && (await dirtyShown()),
    );

    // 保存：草稿删掉
    await cm().click();
    await page.keyboard.press("Control+s");
    await sleep(800);
    check(
      "Ctrl+S 保存：草稿删掉、不再标「未保存」",
      (await draftKeys()).length === 0 && !(await dirtyShown()),
      JSON.stringify(await draftKeys()),
    );
    const saved = execSync(`cat "${dir}/a.txt"`).toString();
    check("磁盘上是改过的内容", saved.includes("草稿一"), saved);
    await closePreview("a.txt");
    // 等前面的提示消失，免得把旧提示当成这次的
    await page.waitForFunction(
      () => !document.querySelector(".u-toast"),
      null,
      {
        timeout: 8000,
      },
    );
    await focusFiles();
    await open("a.txt");
    {
      const st = [await dirtyShown(), await toasts(), await draftKeys()];
      check(
        "保存之后重新打开：没有草稿、没有恢复提示",
        !st[0] &&
          !st[1].some((t) => t?.includes("已恢复")) &&
          st[2].length === 0,
        JSON.stringify(st),
      );
    }

    // 改回原样：草稿删掉
    await typeAtEnd("x");
    await sleep(700);
    check("又打了一个字：有草稿", (await draftOf("a.txt")) !== null);
    await page.keyboard.press("Backspace");
    await sleep(700);
    check(
      "删掉刚打的字、内容与磁盘一致：不再标「未保存」，草稿删掉",
      !(await dirtyShown()) && (await draftKeys()).length === 0,
    );

    // 还原按钮
    await typeAtEnd("多余");
    await sleep(600);
    await page.getByRole("button", { name: "还原" }).click();
    await sleep(500);
    check(
      "「还原」：回到磁盘内容，草稿删掉",
      !(await dirtyShown()) &&
        (await draftKeys()).length === 0 &&
        !(await cm().innerText()).includes("多余"),
    );

    // markdown：切到预览再回编辑
    await focusFiles();
    await open("note.md");
    await typeAtEnd("md草稿");
    await sleep(600);
    await page.getByRole("radio", { name: "预览" }).click();
    await sleep(500);
    await page.getByRole("radio", { name: "编辑" }).click();
    await cm().waitFor();
    await sleep(500);
    check(
      "markdown 切到预览再切回编辑：改动还在",
      (await cm().innerText()).includes("md草稿") && (await dirtyShown()),
    );
    await shot("state-2-markdown");
    await closePreview("note.md");

    // 2) 磁盘在草稿期间被改了：保存走冲突
    await focusFiles();
    await open("b.txt");
    await typeAtEnd("我的");
    await sleep(700);
    await closePreview("b.txt");
    writeFileSync(join(dir, "b.txt"), "bravo 外面改过\n");
    await focusFiles();
    await sleep(500);
    await open("b.txt");
    check(
      "磁盘变过之后重新打开：仍然恢复草稿（显示我的内容）",
      (await cm().innerText()).includes("我的") && (await dirtyShown()),
    );
    await cm().click();
    await page.keyboard.press("Control+s");
    await sleep(800);
    check(
      "保存时走冲突对话框，不静默覆盖",
      (await page.getByRole("dialog").count()) > 0,
    );
    check(
      "磁盘上仍是外面改过的内容",
      execSync(`cat "${dir}/b.txt"`).toString() === "bravo 外面改过\n",
    );
    await shot("state-3-conflict");
    await page.keyboard.press("Escape");
    await sleep(300);

    // 3) 敏感文件不落本地
    await focusFiles();
    const hasEnv =
      (await page.locator(".ws-fm-row[data-name='.env']").count()) > 0;
    if (hasEnv) {
      await open(".env");
      await typeAtEnd("MORE=1");
      await sleep(700);
      check(
        "编辑 .env：标「未保存」，但没有写进本地存储",
        (await dirtyShown()) &&
          (await draftKeys()).every(
            (k) => !k.endsWith(encodeURIComponent(`${dir}/.env`)),
          ),
        JSON.stringify(await draftKeys()),
      );
    } else {
      check("文件管理器默认不显示点文件：跳过 .env 的界面检查", true);
    }

    // 超过 30 天的草稿启动时清掉
    await page.evaluate((k) => {
      const at = (days) =>
        JSON.stringify({
          text: "x",
          base: { mtimeMs: 1, sha256: "x" },
          savedAt: Date.now() - days * 24 * 3600_000,
        });
      localStorage.setItem(`${k}old`, at(31));
      localStorage.setItem(`${k}recent`, at(29));
    }, "ys.file.draft:local:");
    await page.reload();
    await page.waitForSelector(".sh-app");
    await sleep(600);
    const after = await draftKeys();
    check(
      "刷新（启动）时：31 天前的草稿清掉、29 天前的留着",
      !after.includes("ys.file.draft:local:old") &&
        after.includes("ys.file.draft:local:recent"),
      JSON.stringify(after),
    );

    // 4) 各标签的视图状态
    const viewKeys = () =>
      page.evaluate(() =>
        Object.keys(localStorage).filter((k) => k.startsWith("ys.tab.view:")),
      );
    const filesPane = page.locator(".ws-pane", {
      has: page.locator(".ws-pn-tab[data-type='files']"),
    });
    const otherTab = async () => {
      const t = filesPane
        .locator(".ws-pn-tab:not([data-type='files'])")
        .first();
      return (await t.count()) > 0 ? t : null;
    };
    await focusFiles();
    await row("many").click();
    await page.locator('.ws-fm-row[data-name="f89.txt"]').waitFor();
    await sleep(500);
    await row("f03.txt").click({ modifiers: ["Control"] });
    await row("f05.txt").click({ modifiers: ["Control"] });
    await page.getByText("已选 2 项").waitFor();
    await page.locator(".ws-fm-list").evaluate((el) => {
      el.scrollTop = 600;
    });
    await sleep(700);
    const listTop = () =>
      page.locator(".ws-fm-list").evaluate((el) => el.scrollTop);
    const before = await listTop();
    check("文件管理器里滚到了下面", before > 300, String(before));
    const other = await otherTab();
    check("文件管理器所在窗格里有别的标签可切", other !== null);
    if (other) {
      await other.click();
      await sleep(500);
      check(
        "切走后文件管理器卸载了（窗格只渲染当前标签）",
        (await page.locator(".ws-fm-list").count()) === 0,
      );
      await filesPane.locator(".ws-pn-tab[data-type='files']").first().click();
      await page.locator(".ws-fm-list").waitFor();
      await sleep(500);
      const st = [
        await page.getByText("已选 2 项").count(),
        await listTop(),
        await page
          .locator('.ws-fm-row[data-name="f03.txt"]')
          .getAttribute("data-selected"),
      ];
      check(
        "切回来：多选还在（已选 2 项）、列表滚动位置还原",
        st[0] === 1 && Math.abs(st[1] - before) <= 2 && st[2] === "true",
        JSON.stringify([...st, before]),
      );
      await shot("state-4-files-restored");
    }
    await sleep(1500);
    await page.reload();
    await page.locator(".ws-fm-list").waitFor();
    await sleep(800);
    {
      const st = [await page.getByText("已选 2 项").count(), await listTop()];
      check(
        "刷新页面后：多选与滚动位置也在",
        st[0] === 1 && Math.abs(st[1] - before) <= 2,
        JSON.stringify([...st, before]),
      );
    }
    await page.getByRole("button", { name: "取消选择" }).click();

    // 预览：模式与编辑器滚动位置
    await page.getByRole("button", { name: "上一级" }).click();
    await page.locator('.ws-fm-row[data-name="long.txt"]').waitFor();
    await row("long.txt").dblclick();
    await cm().waitFor();
    await sleep(500);
    await cm().click();
    await page.keyboard.press("Control+End");
    await sleep(700);
    const scrolled = () =>
      page.locator(".ws-pv .cm-scroller").evaluate((el) => el.scrollTop);
    const edTop = await scrolled();
    check("长文件里滚到了底部", edTop > 1000, String(edTop));
    await focusFiles();
    await row("c.txt").click();
    await page
      .locator(".ws-pn-tab[data-type='preview']", { hasText: "c.txt" })
      .waitFor();
    await sleep(400);
    await page
      .locator(".ws-pn-tab[data-type='preview']", { hasText: "long.txt" })
      .click();
    await cm().waitFor();
    await sleep(800);
    {
      const top = await scrolled();
      check(
        "切到别的预览标签再切回：编辑器滚动位置还原（不是回到顶部）",
        Math.abs(top - edTop) <= 40,
        JSON.stringify([top, edTop]),
      );
    }
    const modeOf = () =>
      page
        .getByRole("radio", { name: "预览" })
        .getAttribute("aria-checked")
        .catch(() => null);
    await focusFiles();
    await row("note.md").dblclick();
    await cm().waitFor();
    await page.getByRole("radio", { name: "预览" }).click();
    await sleep(600);
    check("note.md 切到了预览", (await modeOf()) === "true");
    await page
      .locator(".ws-pn-tab[data-type='preview']", { hasText: "long.txt" })
      .click();
    await sleep(500);
    await page
      .locator(".ws-pn-tab[data-type='preview']", { hasText: "note.md" })
      .click();
    await sleep(700);
    check(
      "切走再切回：note.md 仍是预览模式",
      (await modeOf()) === "true" &&
        (await page.locator(".ws-pv .cm-content").count()) === 0,
    );
    await shot("state-5-preview-restored");

    // 关掉标签：它的记录一并清掉（标签 id 会复用）
    await sleep(1000);
    const beforeClose = (await viewKeys()).length;
    await closePreview("long.txt");
    await sleep(500);
    const afterClose = (await viewKeys()).length;
    check(
      "关掉预览标签：它的视图状态记录被清掉",
      afterClose === beforeClose - 1,
      JSON.stringify([beforeClose, afterClose]),
    );

    // 5) 没有报错
    // 冲突检查里那次 409 是预期的
    const unexpected = problems.filter(
      (p) =>
        !p.startsWith("409 PUT") && !p.includes("status of 409 (Conflict)"),
    );
    check(
      "全程没有控制台报错与失败的接口请求（冲突检查里的那次 409 除外）",
      unexpected.length === 0,
      unexpected.slice(0, 5).join(" | "),
    );
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (e) {
  check("脚本异常", false, String(e?.stack ?? e).slice(0, 400));
} finally {
  proc.kill();
  rmSync(base, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(
  `\n浏览器本地状态：${results.length - failed}/${results.length} 项通过`,
);
process.exit(failed === 0 ? 0 : 1);
