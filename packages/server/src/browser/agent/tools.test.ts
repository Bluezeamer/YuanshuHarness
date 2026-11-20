// tools.ts 里这批浏览器工具的行为：每条正常路径与每个拒绝分支（动作类工具的细节在 act-tools.test.ts）。
// 全部用替身：不装浏览器、不起进程、不连网络。
import { readFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import {
  cleanupTmpDirs,
  makeToolHarness,
  type ToolHarness,
  verdictOf,
} from "./testkit.js";
import { BROWSER_TOOL_NAMES } from "./tools.js";

afterAll(cleanupTmpDirs);

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

const error = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(Error);
  return (e as Error).message;
};

/** 经工具打开一个公网站点：返回页面编号与它的假页面。 */
async function openViaTool(h: ToolHarness, target = "https://example.com/a") {
  const r = await h.run("browser_open", { target });
  // 页面编号不再出现在工具文字里（内容由清洗器给），从注册表取最近用的那个。
  const pageId = h.registry.list("w1")[0]?.id as string;
  return { pageId, page: h.ctx().pageAt(-1), text: textOf(r) };
}

test("注册的工具名与 BROWSER_TOOL_NAMES 一致，且都不在后台禁区", () => {
  const h = makeToolHarness();
  expect(h.names).toEqual([...BROWSER_TOOL_NAMES]);
  expect(h.names).toHaveLength(26);
  for (const name of h.names) expect(name.startsWith("browser_")).toBe(true);

  // 接管提问要能放进 job_start 后台：FOREGROUND_ONLY 没有导出，直接读源码里那份清单
  const source = readFileSync(
    fileURLToPath(new URL("../../job/tools.ts", import.meta.url)),
    "utf8",
  );
  const list =
    /const FOREGROUND_ONLY = new Set<string>\(\[([\s\S]*?)\]\);/.exec(
      source,
    )?.[1];
  expect(list).toBeTruthy();
  for (const name of h.names) expect(list).not.toContain(`"${name}"`);
});

test("会触发下载的动作：描述里都写了下载要审批、存进附件区", async () => {
  const descriptions = new Map<string, string>();
  const { browserTools } = await import("./tools.js");
  const h = makeToolHarness();
  browserTools(
    h.deps,
    h.sessionId,
  )({
    registerTool: (t: { name: string; description?: string }) =>
      descriptions.set(t.name, t.description ?? ""),
  } as never);
  for (const name of ["browser_open", "browser_click", "browser_press"])
    expect(descriptions.get(name), name).toContain(
      "若这一步触发了文件下载，会请用户批准；通过后文件存进本会话的附件区，结果里给出它的 attachment:/… 地址。",
    );
  expect(descriptions.get("browser_type")).not.toContain(
    "若这一步触发了文件下载",
  );
});

test("工具描述都提到页面内容不可信", async () => {
  const descriptions = new Map<string, string>();
  // 直接从注册的工厂再抓一遍描述
  const { browserTools } = await import("./tools.js");
  const h = makeToolHarness();
  browserTools(
    h.deps,
    h.sessionId,
  )({
    registerTool: (t: { name: string; description?: string }) =>
      descriptions.set(t.name, t.description ?? ""),
  } as never);
  const withContent = [
    "browser_open",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_press",
    "browser_move",
    "browser_scroll",
    "browser_drag",
    "browser_nav",
    "browser_screenshot",
    "browser_assets",
    "browser_upload",
    "browser_console",
    "browser_dom",
    "browser_network",
    "browser_exec",
    "browser_storage",
    "browser_request",
    "browser_dialog",
  ];
  for (const name of withContent)
    expect(descriptions.get(name), name).toContain("不可信");
  expect(descriptions.get("browser_handoff")).not.toContain("不可信");
  expect(descriptions.get("browser_show")).not.toContain("不可信");
});

describe("browser_open", () => {
  test("公网已批准：新开页面、内容走清洗器（ACTION + PAGE ID 行）", async () => {
    const h = makeToolHarness();
    h.deps.access = { approved: () => true, known: () => true };
    h.cleaner.result = "清洗后的页面";
    const { pageId, page, text } = await openViaTool(h);
    expect(text).toBe("清洗后的页面");
    expect(h.registry.list("w1")).toHaveLength(1);
    expect(h.registry.get(pageId)?.url).toBe("https://example.com/a");
    expect(page.calls).toEqual(["goto https://example.com/a", "snapshot"]);
    expect(h.cleaner.calls).toHaveLength(1);
    expect(h.cleaner.calls[0]).toMatchObject({
      sessionId: h.sessionId,
      pageId,
      explicit: false,
      url: "https://example.com/a",
      action: "open https://example.com/a",
      notes: [`PAGE ID: ${pageId} · HTTP 200`],
    });
    expect(h.approvals).toEqual([]);
    expect(h.audit).toEqual([
      { tool: "browser_open", pageId, summary: "打开 https://example.com/a" },
    ]);
  });

  test("公网未批准：先调 approveOpen；被拒就不打开", async () => {
    const h = makeToolHarness();
    h.approve = [false];
    const r = await h.run("browser_open", { target: "https://example.com/a" });
    expect(textOf(r)).toBe("用户没有批准访问 https://example.com");
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]?.origin).toBe("https://example.com");
    expect(h.approvals[0]?.reason).toContain("https://example.com");
    expect(h.registry.list("w1")).toEqual([]);
    expect(h.cleaner.calls).toEqual([]);
  });

  test("审批通过后正常打开，内容里带 PAGE ID 与 HTTP 状态", async () => {
    const h = makeToolHarness();
    h.approve = [true];
    const { pageId } = await openViaTool(h);
    expect(h.registry.get(pageId)?.url).toBe("https://example.com/a");
    expect(h.cleaner.calls.at(-1)?.notes).toEqual([
      `PAGE ID: ${pageId} · HTTP 200`,
    ]);
  });

  test("文件与见过的服务目标免审批；三种目标都解析成正确的地址", async () => {
    const h = makeToolHarness({
      access: { approved: () => false, known: () => true },
    });
    await openViaTool(h, "/w/index.html");
    await openViaTool(h, "web1:3000/login");
    await openViaTool(h, "http://web1.localhost:5173/x?y=1");
    expect(
      h.cleaner.calls.map((c) => c.notes?.[0]?.endsWith("HTTP 200")),
    ).toEqual([true, true, true]);
    expect(h.approvals).toEqual([]);
    // 列表按最近使用倒序，这里只比集合
    expect(
      h.registry
        .list("w1")
        .map((p) => p.url)
        .sort(),
    ).toEqual([
      "http://e2.localhost:3000/login",
      "http://server.files.localhost/w/index.html",
      "http://web1.localhost:5173/x?y=1",
    ]);
  });

  test("已批准的来源免审批，未见过也没批准过的端口要问", async () => {
    // 已批准：origin 落在 approveOpen 记下的那张表里
    const h = makeToolHarness({
      access: {
        approved: (_w, origin) => origin === "http://e2.localhost:3000",
        known: () => false,
      },
    });
    const first = await openViaTool(h, "web1:3000/login");
    expect(h.cleaner.calls.at(-1)?.notes).toEqual([
      `PAGE ID: ${first.pageId} · HTTP 200`,
    ]);
    expect(h.approvals).toEqual([]);

    // 没见过也没批准过：弹审批卡片，带 service 标记与 agent 原样写的目标
    const ask = makeToolHarness();
    ask.approve = [true];
    await openViaTool(ask, "web1:3000/login");
    expect(ask.cleaner.calls).toHaveLength(1);
    expect(ask.approvals).toEqual([
      {
        origin: "http://e2.localhost:3000",
        reason:
          "agent 要访问 web1:3000/login 上的服务（这个端口没在命令输出里出现过）",
        service: true,
      },
    ]);
  });

  test("服务审批被拒：不打开，告诉模型没被批准", async () => {
    const h = makeToolHarness();
    h.approve = [false];
    const r = await h.run("browser_open", { target: "server:5173" });
    expect(textOf(r)).toBe("用户没有批准访问 http://server.localhost:5173");
    expect(h.approvals).toHaveLength(1);
    expect(h.registry.list("w1")).toEqual([]);
  });

  test("TargetError 的消息原样给模型", async () => {
    const h = makeToolHarness();
    expect(
      await error(h.run("browser_open", { target: "ftp://x.test/" })),
    ).toBe("只支持 http 与 https 地址、绝对文件路径、host:端口");
    expect(
      await error(h.run("browser_open", { target: "example.com:8080" })),
    ).toBe("找不到主机 example.com；公网地址要带 http:// 或 https:// 前缀");
  });

  test("带 pageId 是在那个页面里导航，不开新页面", async () => {
    const h = makeToolHarness();
    h.deps.access = { approved: () => true, known: () => true };
    const { pageId } = await openViaTool(h);
    const r = await h.run("browser_open", {
      target: "https://example.com/b",
      pageId,
    });
    expect(textOf(r)).toContain("清洗后的页面");
    expect(h.registry.list("w1")).toHaveLength(1);
    expect(h.registry.get(pageId)?.url).toBe("https://example.com/b");
    // 两次都走完整路径（动作后 content 的 explicit 缺省 false，新页面没有基线）
    expect(h.cleaner.calls.map((c) => c.action)).toEqual([
      "open https://example.com/a",
      "open https://example.com/b",
    ]);
    expect(h.audit.at(-1)?.summary).toBe("导航到 https://example.com/b");
  });

  test("goto 带回 deny：翻成中文原因拼进结果，且不再取快照", async () => {
    const cases = [
      [
        "blocked_address",
        "该地址落在内网、回环、链路本地或保留网段，浏览器代理不允许访问",
      ],
      ["auth", "浏览器代理认证失败（上下文令牌失效）"],
      ["service_denied", "当前上下文不允许访问这个主机上的这个端口"],
      ["file_denied", "不在这个工作区的目录里"],
    ] as const;
    for (const [deny, expectText] of cases) {
      const h = makeToolHarness(
        {},
        {
          onCtx: (c) => {
            c.pageInit = (p) => {
              (p as unknown as { gotoResult: unknown }).gotoResult = {
                status: 407,
                deny,
              };
            };
          },
        },
      );
      h.deps.access = { approved: () => true, known: () => true };
      const { text } = await openViaTool(h);
      expect(text).toContain("HTTP 407");
      expect(text).toContain(expectText);
      expect(text).not.toContain("清洗后的页面");
      expect(h.cleaner.calls).toEqual([]);
    }
  });

  test("参数不是字符串时报参数错误", async () => {
    const h = makeToolHarness();
    expect(
      await error(
        h.run("browser_open", { target: "https://x.test/", pageId: 5 }),
      ),
    ).toBe("pageId 必须是 browser_pages 或 browser_open 给出的页面编号");
    expect(await error(h.run("browser_open", {}))).toContain(
      "target 必须是字符串",
    );
  });
});

describe("browser_pages / browser_close", () => {
  test("列出本工作区页面（含休眠），标出操作者与是否本会话用过", async () => {
    const h = makeToolHarness();
    h.deps.access = { approved: () => true, known: () => true };
    const { pageId } = await openViaTool(h);
    expect(textOf(await h.run("browser_pages"))).toBe(
      `${pageId} · （无标题） · https://example.com/a（激活，agent 操作，本会话用过）`,
    );

    await h.registry.sleep(pageId);
    expect(textOf(await h.run("browser_pages"))).toBe(
      `${pageId} · （无标题） · https://example.com/a（休眠，agent 操作，本会话用过）`,
    );

    // 换个会话看同一个页面：不再标「本会话用过」
    const other = makeToolHarness(
      { registry: h.registry },
      { sessionId: "s2" },
    );
    expect(textOf(await other.run("browser_pages"))).toBe(
      `${pageId} · （无标题） · https://example.com/a（休眠，agent 操作）`,
    );
  });

  test("空工作区", async () => {
    const h = makeToolHarness();
    expect(textOf(await h.run("browser_pages"))).toContain("还没有浏览器页面");
  });

  test("close：关掉页面、不碰清洗器（基线由注册表的 removed 事件清）", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    h.cleaner.forgot.length = 0;
    expect(textOf(await h.run("browser_close", { pageId }))).toBe(
      `页面 ${pageId} 已关闭。`,
    );
    expect(h.registry.list("w1")).toEqual([]);
    expect(h.cleaner.forgot).toEqual([]);
    expect(h.audit.at(-1)?.tool).toBe("browser_close");
  });

  test("close：PageError 原样给模型", async () => {
    const h = makeToolHarness();
    expect(await error(h.run("browser_close", { pageId: "nope" }))).toContain(
      "没有这个页面（nope）",
    );
    // 用户手动操作的页面不让 agent 关
    const { pageId } = await openViaTool(h);
    h.registry.control(pageId, "user");
    const msg = await error(h.run("browser_close", { pageId }));
    expect(msg).toContain("用户手动操作");
    expect(msg.split("\n")).toHaveLength(1);
  });
});

describe("操作权与认领", () => {
  test("用户手动操作时，动手类工具都被拒；只读照常", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    h.registry.control(pageId, "user");
    for (const [tool, params] of [
      ["browser_click", { pageId, ref: "e1" }],
      ["browser_type", { pageId, text: "x" }],
      ["browser_press", { pageId, key: "Enter" }],
      ["browser_open", { pageId, target: "https://example.com/b" }],
    ] as const)
      expect(await error(h.run(tool, params)), tool).toContain("用户正在操作");

    // 只读四件套照常
    await expect(h.run("browser_snapshot", { pageId })).resolves.toBeTruthy();
    await expect(h.run("browser_screenshot", { pageId })).resolves.toBeTruthy();
    await expect(h.run("browser_console", { pageId })).resolves.toBeTruthy();
    await expect(h.run("browser_pages")).resolves.toBeTruthy();
  });

  test("别的会话在用且正忙：busy", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    // 页面记在 s1 名下，s1 正在跑一轮；换一个会话的窗口来动手
    h.pages.busy.add("s1");
    const other = makeToolHarness(
      { registry: h.registry },
      { sessionId: "s2" },
    );
    const msg = await error(other.run("browser_click", { pageId, ref: "e1" }));
    expect(msg).toContain("正被会话");
    // 在用的会话没在忙时可以自动认领
    h.pages.busy.delete("s1");
    await expect(
      other.run("browser_click", { pageId, ref: "e1" }),
    ).resolves.toBeTruthy();
    expect(h.registry.get(pageId)?.inUseBy).toBe("s2");
  });
});

describe("browser_click", () => {
  test("ref 路径：ACTION 行写 click e12", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const r = await h.run("browser_click", { pageId, ref: "e12" });
    expect(textOf(r)).toBe("清洗后的页面");
    expect(page.calls).toContain("click e12 1 left");
    expect(h.cleaner.calls.at(-1)?.action).toBe("click e12");
    expect(h.cleaner.calls.at(-1)?.explicit).toBe(false);
    expect(h.audit.at(-1)?.summary).toBe("点击 e12");
  });

  test("x + y 路径：一次 clickAt，不再发 move / down / up", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const r = await h.run("browser_click", { pageId, x: 100, y: 200 });
    expect(textOf(r)).toBe("清洗后的页面");
    expect(h.cleaner.calls.at(-1)?.action).toBe("click (100,200)");
    expect(page.calls).toContain("clickAt 100,200 1 left");
    expect(page.calls.filter((c) => c.startsWith("input mouse"))).toEqual([]);
  });

  test("不给目标：点当前鼠标位置", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.mouseAt = { x: 120, y: 80 };
    await h.run("browser_click", { pageId });
    expect(page.calls).toContain("clickAt 120,80 1 left");
    expect(h.cleaner.calls.at(-1)?.action).toBe("click at mouse (120,80)");
  });

  test("ref 与 x、y 同给、只给一个坐标：报错", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    expect(
      await error(h.run("browser_click", { pageId, ref: "e1", x: 1, y: 2 })),
    ).toContain("ref 与 x、y 只能给一组");
    // 只给一个坐标也算坐标
    expect(await error(h.run("browser_click", { pageId, x: 1 }))).toContain(
      "x 与 y 要成对给",
    );
    expect(
      await error(h.run("browser_click", { pageId, ref: "12" })),
    ).toContain("ref 必须是最近一次快照里的元素编号");
  });

  test("坐标越界：报错并说明视口是 1280×800", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    for (const [x, y, name] of [
      [1280, 10, "x"],
      [10, 800, "y"],
      [-1, 10, "x"],
      [10, -1, "y"],
    ] as const) {
      const msg = await error(h.run("browser_click", { pageId, x, y }));
      expect(msg, `${name}=${name === "x" ? x : y}`).toContain("超出视口");
      expect(msg).toContain("1280×800");
    }
    // 边界内可以用
    await expect(
      h.run("browser_click", { pageId, x: 1279, y: 799 }),
    ).resolves.toBeTruthy();
  });
});

describe("browser_type", () => {
  test("带 ref：替换内容，submit 透传", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    await h.run("browser_type", {
      pageId,
      ref: "e3",
      text: "hello",
      submit: true,
    });
    expect(page.calls).toContain("type e3 hello true");
    expect(h.cleaner.calls.at(-1)?.action).toBe("type 5 chars into e3, Enter");
  });

  test("不带 ref：输入到聚焦元素；submit 再回车", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    await h.run("browser_type", { pageId, text: "你好" });
    expect(page.calls).toContain("input text 你好");
    expect(page.calls).not.toContain("press Enter");

    const p2 = await h.run("browser_type", { pageId, text: "x", submit: true });
    expect(p2).toBeTruthy();
    expect(page.calls).toContain("press Enter");
  });

  test("text 超长报错", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    const msg = await error(
      h.run("browser_type", { pageId, text: "x".repeat(2001) }),
    );
    expect(msg).toContain("text 最长 2000 字符");
  });

  test("审计只写长度、不写原文", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    await h.run("browser_type", { pageId, ref: "e3", text: "my-secret-pw" });
    const audit = JSON.stringify(h.audit);
    expect(audit).not.toContain("my-secret-pw");
    expect(h.audit.at(-1)?.summary).toBe("输入到 e3，12 字");
  });
});

describe("browser_press", () => {
  test("按键并取 follow 快照", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const r = await h.run("browser_press", { pageId, key: "ArrowDown" });
    expect(textOf(r)).toBe("清洗后的页面");
    expect(page.calls).toContain("press ArrowDown");
    expect(h.cleaner.calls.at(-1)?.action).toBe("press ArrowDown");
  });
});

describe("browser_snapshot", () => {
  test("默认永远走完整路径（explicit: true），没有 ACTION 行", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    h.cleaner.calls.length = 0;
    const r = await h.run("browser_snapshot", { pageId });
    expect(textOf(r)).toBe("清洗后的页面");
    expect(page.calls.at(-1)).toBe("snapshot");
    expect(h.cleaner.calls).toHaveLength(1);
    expect(h.cleaner.calls[0]).toMatchObject({ pageId, explicit: true });
    expect(h.cleaner.calls[0]?.action).toBeUndefined();
  });

  test("raw: true 给完整原始快照、不走清洗器，并重置基线", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    h.cleaner.calls.length = 0;
    const r = await h.run("browser_snapshot", { pageId, raw: true });
    expect(textOf(r)).toBe("（原始快照，未压缩）\n- button e1");
    expect(h.cleaner.calls).toEqual([]);
    expect(h.cleaner.rebased).toEqual([
      {
        sessionId: h.sessionId,
        pageId,
        raw: "- button e1",
        url: "https://example.com/a",
      },
    ]);
  });

  test("scope 参数已经取消", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    // 旧参数不再被读取：不会因此报错，也不会改变行为
    const r = await h.run("browser_snapshot", { pageId, scope: "all" });
    expect(textOf(r)).toBe("清洗后的页面");
    const { browserTools } = await import("./tools.js");
    const descs = new Map<string, string>();
    browserTools(
      h.deps,
      h.sessionId,
    )({
      registerTool: (t: { name: string; description?: string }) =>
        descs.set(t.name, t.description ?? ""),
    } as never);
    expect(descs.get("browser_snapshot")).not.toContain("scope");
  });
});

describe("intent 与 signal 的传递", () => {
  test("intent 原样传给清洗器；不给就是 undefined", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    await h.run("browser_click", { pageId, ref: "e1", intent: "找登录按钮" });
    expect(h.cleaner.calls.at(-1)?.intent).toBe("找登录按钮");
    await h.run("browser_click", { pageId, ref: "e1" });
    expect(h.cleaner.calls.at(-1)?.intent).toBeUndefined();
    expect(
      await error(h.run("browser_click", { pageId, ref: "e1", intent: 3 })),
    ).toBe("intent 必须是字符串");
  });

  test("返回页面内容的工具都带 intent，非内容工具不带", async () => {
    const descriptions = new Map<string, { description?: string }>();
    const { browserTools } = await import("./tools.js");
    const h = makeToolHarness();
    browserTools(
      h.deps,
      h.sessionId,
    )({
      registerTool: (t: {
        name: string;
        description?: string;
        parameters?: { properties?: Record<string, unknown> };
      }) => {
        descriptions.set(t.name, t);
      },
    } as never);
    const sentence =
      "intent: optional. When the page changed a lot and has to be re-read, say what you are looking for on it; without it you get an overview of the page.";
    for (const name of [
      "browser_open",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_move",
      "browser_scroll",
      "browser_drag",
      "browser_nav",
      "browser_upload",
      "browser_dialog",
      "browser_handoff",
    ]) {
      const props = (
        descriptions.get(name) as {
          parameters?: { properties?: Record<string, unknown> };
        }
      ).parameters?.properties;
      expect(props, name).toHaveProperty("intent");
      const desc = (props?.intent as { description?: string } | undefined)
        ?.description;
      expect(desc, name).toBe(sentence);
    }
    for (const name of [
      "browser_pages",
      "browser_close",
      "browser_screenshot",
      "browser_assets",
      "browser_console",
      "browser_dom",
      "browser_network",
      "browser_exec",
      "browser_storage",
      "browser_request",
      "browser_route",
      "browser_emulate",
      "browser_cdp",
      "browser_show",
    ]) {
      const props = (
        descriptions.get(name) as {
          parameters?: { properties?: Record<string, unknown> };
        }
      ).parameters?.properties;
      expect(props ?? {}, name).not.toHaveProperty("intent");
    }
  });

  test("signal 从 execute 透传给清洗器", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    const ctl = new AbortController();
    await h.run("browser_press", { pageId, key: "Enter" }, ctl.signal);
    expect(h.cleaner.calls.at(-1)?.signal).toBe(ctl.signal);
    await h.run("browser_press", { pageId, key: "Enter" });
    expect(h.cleaner.calls.at(-1)?.signal).toBeUndefined();
  });

  test("browser_open 的 intent 也传下去", async () => {
    const h = makeToolHarness();
    h.deps.access = { approved: () => true, known: () => true };
    await h.run("browser_open", {
      target: "https://example.com/a",
      intent: "找搜索框",
    });
    expect(h.cleaner.calls.at(-1)?.intent).toBe("找搜索框");
  });
});

describe("操作权易手", () => {
  test("交还之后基线不作废：没有 forgetPage，下一次内容工具照常与交出前的状态比较", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h);
    h.cleaner.forgot.length = 0;
    h.cleaner.calls.length = 0;

    // 用户接管页面再交还给 agent
    h.registry.control(pageId, "user");
    h.registry.control(pageId, "agent");
    await h.run("browser_press", { pageId, key: "Enter" });
    expect(h.cleaner.forgot).toEqual([]);
    expect(h.cleaner.calls).toHaveLength(1);
    expect(h.cleaner.calls[0]).toMatchObject({
      pageId,
      explicit: false,
      action: "press Enter",
    });
  });
});

describe("站点批准的记忆由调用方负责", () => {
  test("approveOpen 把站点记进 access 后，同站点再开不再询问", async () => {
    const approvedSet = new Set<string>();
    let asked = 0;
    const h = makeToolHarness({
      access: {
        approved: (_w, origin) => approvedSet.has(origin),
        known: () => false,
      },
      approveOpen: async ({ origin }) => {
        asked += 1;
        approvedSet.add(origin);
        return { allowed: true };
      },
    });
    await h.run("browser_open", { target: "https://example.com/a" });
    await h.run("browser_open", { target: "https://example.com/b" });
    expect(asked).toBe(1);
    // 换一个站点仍要问
    await h.run("browser_open", { target: "https://other.example/" });
    expect(asked).toBe(2);
  });
});

describe("高敏感站点：每个动作先确认", () => {
  type Confirm = { tool: string; host: string; summary: string };
  const harness = (answers: boolean[]) => {
    const confirms: Confirm[] = [];
    const h = makeToolHarness({
      async confirmAction(args) {
        confirms.push(args);
        return verdictOf(answers.shift());
      },
    });
    return { h, confirms };
  };
  const actions = [
    ["browser_click", { ref: "e1" }, "点击 e1", "click e1"],
    ["browser_type", { ref: "e2", text: "hi" }, "输入", "type e2 hi"],
    ["browser_press", { key: "Enter" }, "按键 Enter", "press Enter"],
  ] as const;

  test.each(actions)(
    "%s：确认通过才动手，卡片摘要带动作",
    async (tool, args, summary, call) => {
      const { h, confirms } = harness([true]);
      const { pageId, page } = await openViaTool(
        h,
        "https://gist.github.com/a",
      );
      await h.run(tool, { pageId, ...args });
      expect(confirms).toHaveLength(1);
      expect(confirms[0]?.tool).toBe(tool);
      expect(confirms[0]?.host).toBe("gist.github.com");
      expect(confirms[0]?.summary).toContain(summary);
      expect(page.calls.some((c) => c.startsWith(call))).toBe(true);
    },
  );

  test.each(actions)(
    "%s：确认被拒绝就不动手，错误说明原因",
    async (tool, args, _s, call) => {
      const { h } = harness([false]);
      const { pageId, page } = await openViaTool(h, "https://github.com/a");
      const msg = await error(h.run(tool, { pageId, ...args }));
      expect(msg).toContain("没有批准");
      expect(msg).toContain("github.com");
      expect(page.calls.some((c) => c.startsWith(call))).toBe(false);
    },
  );

  test("普通站点不确认", async () => {
    const { h, confirms } = harness([false]);
    const { pageId } = await openViaTool(h, "https://example.com/a");
    await h.run("browser_press", { pageId, key: "Enter" });
    expect(confirms).toEqual([]);
  });

  test("没有提供 confirmAction 就不确认（调用方没接线时的行为）", async () => {
    const h = makeToolHarness();
    const { pageId } = await openViaTool(h, "https://github.com/a");
    await expect(
      h.run("browser_press", { pageId, key: "Enter" }),
    ).resolves.toBeDefined();
  });

  test("输入的确认摘要只写长度，不带文字", async () => {
    const { h, confirms } = harness([true]);
    const { pageId } = await openViaTool(h, "https://github.com/a");
    await h.run("browser_type", { pageId, ref: "e2", text: "my-secret-pw" });
    expect(JSON.stringify(confirms)).not.toContain("my-secret-pw");
    expect(confirms[0]?.summary).toContain("12");
  });

  test("只读工具不确认", async () => {
    const { h, confirms } = harness([false]);
    const { pageId } = await openViaTool(h, "https://github.com/a");
    await h.run("browser_snapshot", { pageId });
    await h.run("browser_screenshot", { pageId });
    await h.run("browser_console", { pageId });
    await h.run("browser_dom", { pageId });
    await h.run("browser_network", { pageId });
    expect(confirms).toEqual([]);
  });
});

describe("回放：改变页面的动作记一步", () => {
  type Recorded = {
    sessionId: string;
    workspaceKey: string;
    pageId: string;
    tool: string;
    summary: string;
  };

  /** 带记步替身的工作台：recorded 是每次 recordStep 的入参。 */
  const replayHarness = () => {
    const recorded: Recorded[] = [];
    const h = makeToolHarness({
      access: { approved: () => true, known: () => true },
      recordStep: async (a) => {
        recorded.push(a);
      },
    });
    return { h, recorded };
  };

  test("open（新开与导航）、click、type、press、handoff done 各记一次，摘要与审计一致", async () => {
    const { h, recorded } = replayHarness();
    await h.run("browser_open", { target: "https://a.test/" });
    const pageId = h.registry.list("w1")[0]?.id as string;
    await h.run("browser_open", { target: "https://a.test/b", pageId });
    await h.run("browser_click", { pageId, ref: "e1" });
    await h.run("browser_type", { pageId, ref: "e3", text: "hello" });
    await h.run("browser_press", { pageId, key: "Enter" });
    h.registry.control(pageId, "user");
    await h.run("browser_handoff", { pageId, reason: "登录" });

    expect(recorded.map((r) => r.tool)).toEqual([
      "browser_open",
      "browser_open",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_handoff",
    ]);
    // 摘要就是审计那一串，同一次动作两边完全一样
    expect(recorded.map((r) => r.summary)).toEqual(
      h.audit.map((a) => a.summary),
    );
    expect(recorded[0]).toMatchObject({
      sessionId: h.sessionId,
      workspaceKey: "w1",
      pageId,
      summary: "打开 https://a.test/",
    });
    // 页面此刻是用户在操作：方向是「请求使用」，交还的摘要也随之不同
    expect(recorded[5]?.summary).toBe("用户把页面交给了 agent");
  });

  test("browser_type 的摘要只有字数，不含输入的文字", async () => {
    const { h, recorded } = replayHarness();
    const { pageId } = await openViaTool(h, "https://a.test/");
    recorded.length = 0;
    await h.run("browser_type", { pageId, ref: "e3", text: "my-secret-pw" });
    await h.run("browser_type", { pageId, text: "my-secret-pw" });
    const json = JSON.stringify(recorded);
    expect(json).not.toContain("my-secret-pw");
    expect(recorded.map((r) => r.summary)).toEqual([
      "输入到 e3，12 字",
      "输入到聚焦元素，12 字",
    ]);
  });

  test("只读工具与 close 不记步", async () => {
    const { h, recorded } = replayHarness();
    const { pageId } = await openViaTool(h, "https://a.test/");
    recorded.length = 0;
    await h.run("browser_pages");
    await h.run("browser_snapshot", { pageId });
    await h.run("browser_screenshot", { pageId });
    await h.run("browser_console", { pageId });
    await h.run("browser_dom", { pageId });
    await h.run("browser_network", { pageId });
    await h.run("browser_close", { pageId });
    expect(recorded).toEqual([]);
  });

  test("接管被拒 / 超时 / 取消不记步", async () => {
    const { h, recorded } = replayHarness();
    const { pageId } = await openViaTool(h, "https://a.test/");
    recorded.length = 0;
    h.replies.push({ outcome: "timeout" }, { outcome: "cancelled" });
    await h.run("browser_handoff", { pageId, reason: "登录" });
    await h.run("browser_handoff", { pageId, reason: "登录" });
    h.replies.push({ outcome: "answered", optionId: "refuse", text: "不" });
    await h.run("browser_handoff", { pageId, reason: "登录" });
    expect(recorded).toEqual([]);
  });

  test("没提供 recordStep 时一切照常", async () => {
    const h = makeToolHarness({
      access: { approved: () => true, known: () => true },
    });
    expect(h.deps.recordStep).toBeUndefined();
    const { pageId } = await openViaTool(h);
    await h.run("browser_click", { pageId, ref: "e1" });
    await h.run("browser_type", { pageId, text: "x" });
    await h.run("browser_press", { pageId, key: "Enter" });
    h.registry.control(pageId, "user");
    await h.run("browser_handoff", { pageId, reason: "登录" });
    expect(h.audit.map((a) => a.tool)).toEqual([
      "browser_open",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_handoff",
    ]);
  });

  test("acted 里 await 了 recordStep：工具的返回晚于记步落定", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gated = false;
    let recorded = 0;
    const h = makeToolHarness({
      recordStep: async () => {
        recorded += 1;
        if (gated) await gate;
      },
    });
    const { pageId } = await openViaTool(h);
    gated = true;
    let returned = false;
    const run = h.run("browser_click", { pageId, ref: "e1" }).then((r) => {
      returned = true;
      return r;
    });
    // 让出几个微任务（动作结束还要等下载宽限 400ms）：记步还没落定时工具不能返回
    await new Promise((r) => setTimeout(r, 500));
    expect(recorded).toBe(2);
    expect(returned).toBe(false);
    release();
    await run;
    expect(returned).toBe(true);
  });
});

// —— 下载 ——

/** 给假页面塞一次下载（返回记录取消原因的数组）；派发走 registry 绑上的订阅者。 */
const emitDownload = (
  h: ToolHarness,
  d: {
    filename: string;
    url?: string;
    saveTo?: (
      dest: string,
      opts: { maxBytes: number; timeoutMs: number },
    ) => Promise<number>;
    cancel?: (reason: string) => Promise<void>;
  },
) => {
  const page = h.ctx().pageAt(-1);
  const cancelled: string[] = [];
  page.emitDownload({
    filename: d.filename,
    url: d.url ?? `https://example.com/${d.filename}?token=***`,
    saveTo:
      d.saveTo ??
      (async (dest) => {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(dest, "downloaded");
        return 10;
      }),
    cancel: async (reason) => {
      cancelled.push(reason);
      await d.cancel?.(reason);
    },
  });
  return cancelled;
};

test("点击触发下载：审批通过后结果里有 [attach_file] 行，字节进了附件区", async () => {
  const h = makeToolHarness();
  const { pageId } = await openViaTool(h);
  const page = h.ctx().pageAt(-1);
  const original = page.click.bind(page);
  page.click = async (ref: string) => {
    await original(ref);
    emitDownload(h, {
      filename: "报表.csv",
      url: "https://example.com/export?token=***",
    });
  };
  const r = await h.run("browser_click", { pageId, ref: "e1" });
  // 下载文字行不再接在内容后面，而是作为 NOTES 交给清洗器的 notes
  const notes = h.cleaner.calls.at(-1)?.notes ?? [];
  expect(notes.join("\n")).toContain("Downloaded: 报表.csv (10 B)");
  expect(notes.join("\n")).toContain("attachment:/");
  expect(textOf(r)).toBe("清洗后的页面");
  expect(h.downloadApprovals).toEqual([
    {
      filename: "报表.csv",
      pageUrl: "https://example.com/a",
      fileUrl: "https://example.com/export?token=***",
      executable: false,
    },
  ]);
  expect(h.savedDownloads).toEqual([{ name: "报表.csv", size: 10 }]);
  // 审计里有一条保存下载
  expect(h.audit.map((a) => a.tool)).toContain("browser_download");
});

test("点击触发下载：用户拒绝 → 说「用户没有批准下载」且没存", async () => {
  const h = makeToolHarness();
  h.approveDownloadReplies = [false];
  const { pageId } = await openViaTool(h);
  const page = h.ctx().pageAt(-1);
  const original = page.click.bind(page);
  let cancelled: string[] = [];
  page.click = async (ref: string) => {
    await original(ref);
    cancelled = emitDownload(h, { filename: "a.zip" });
  };
  await h.run("browser_click", { pageId, ref: "e1" });
  const notes = (h.cleaner.calls.at(-1)?.notes ?? []).join("\n");
  expect(notes).toContain("用户没有批准下载 a.zip，已取消。");
  expect(h.savedDownloads).toEqual([]);
  expect(cancelled).toEqual(["用户没有批准"]);
});

test("browser_type 不带 submit 不开下载窗口，带 submit 才开", async () => {
  const h = makeToolHarness();
  const { pageId } = await openViaTool(h);
  const before = h.collects.length;
  await h.run("browser_type", { pageId, text: "hello" });
  expect(h.collects).toHaveLength(before);
  await h.run("browser_type", { pageId, text: "hello", submit: true });
  expect(h.collects).toHaveLength(before + 1);
  expect(h.collects.at(-1)?.pageId).toBe(pageId);
});

test("browser_open 打开下载地址：刚开的页面被关掉，结果里没有 pageId", async () => {
  // goto 因为地址是下载返回 status 为 null（真引擎里 page.goto 会抛「Download is starting」）
  const h = makeToolHarness(
    {},
    {
      onCtx: (c) => {
        c.pageInit = (p) => {
          const original = p.goto.bind(p);
          p.goto = async (url: string) => {
            await original(url);
            p.emitDownload({
              filename: "export.csv",
              url: "https://example.com/export.csv",
              saveTo: async (dest) => {
                const { writeFileSync } = await import("node:fs");
                writeFileSync(dest, "csv");
                return 3;
              },
              cancel: async () => {},
            });
            return { status: null, deny: null };
          };
        };
      },
    },
  );
  const out = textOf(
    await h.run("browser_open", { target: "https://example.com/export.csv" }),
  );
  expect(out).toContain("是文件下载，不是网页，没有打开页面。");
  expect(out).toContain("Downloaded: export.csv");
  expect(out).not.toMatch(/页面 p[a-z0-9]+ 已打开/);
  expect(h.registry.list("w1")).toHaveLength(0);
  expect(h.ctx().pageAt(-1).closed).toBe(true);
});

test("已有页面导航到下载地址：页面保留，照常取快照并附下载行", async () => {
  const h = makeToolHarness();
  const { pageId } = await openViaTool(h);
  const page = h.ctx().pageAt(-1);
  const original = page.goto.bind(page);
  page.goto = async (url: string) => {
    await original(url);
    page.emitDownload({
      filename: "export.csv",
      url: "https://example.com/export.csv",
      saveTo: async (dest) => {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(dest, "csv");
        return 3;
      },
      cancel: async () => {},
    });
    return { status: null, deny: null };
  };
  await h.run("browser_open", {
    target: "https://example.com/export.csv",
    pageId,
  });
  expect(h.cleaner.calls.at(-1)?.notes?.join("\n")).toContain(
    "Downloaded: export.csv",
  );
  expect(h.cleaner.calls.at(-1)?.notes?.[0]).toBe(
    `PAGE ID: ${pageId} · HTTP none`,
  );
  expect(h.registry.get(pageId)).not.toBeNull();
  expect(page.closed).toBe(false);
});

test("一次动作触发 4 个下载：只处理 3 个，并提示 dropped", async () => {
  const h = makeToolHarness();
  const { pageId } = await openViaTool(h);
  const page = h.ctx().pageAt(-1);
  const original = page.click.bind(page);
  const cancelled: string[] = [];
  page.click = async (ref: string) => {
    await original(ref);
    for (let i = 1; i <= 4; i++)
      emitDownload(h, {
        filename: `${i}.zip`,
        cancel: async (reason) => void cancelled.push(reason),
      });
  };
  const out = textOf(await h.run("browser_click", { pageId, ref: "e1" }));
  expect(h.savedDownloads.map((s) => s.name)).toEqual([
    "1.zip",
    "2.zip",
    "3.zip",
  ]);
  expect(out).toBe("清洗后的页面");
  expect(h.cleaner.calls.at(-1)?.notes?.join("\n")).toContain(
    "这次动作还触发了 1 个下载，一次最多处理 3 个，其余已取消。",
  );
  expect(cancelled).toEqual(["一次动作最多收 3 个下载"]);
});

test("动作抛错：已收到的下载被取消，错误原样抛出", async () => {
  const h = makeToolHarness();
  const { pageId } = await openViaTool(h);
  const page = h.ctx().pageAt(-1);
  const cancelled: string[] = [];
  page.click = async () => {
    emitDownload(h, {
      filename: "x.zip",
      cancel: async (reason) => void cancelled.push(reason),
    });
    throw new Error("点击失败：元素不可见");
  };
  const msg = await error(h.run("browser_click", { pageId, ref: "e1" }));
  await new Promise((r) => setTimeout(r, 0));
  expect(msg).toContain("元素不可见");
  expect(cancelled).toEqual(["动作失败"]);
  expect(h.savedDownloads).toEqual([]);
});

test("窗口外触发的下载被取消（没有 agent 动作在等）", async () => {
  const h = makeToolHarness();
  await openViaTool(h);
  const cancelled = emitDownload(h, { filename: "late.zip" });
  await new Promise((r) => setTimeout(r, 0));
  expect(cancelled).toEqual(["没有对应的 agent 动作"]);
});

// —— 上传 ——

test("上传：通过后页面收到原文件名与原字节，结果里有文件名与大小", async () => {
  const h = makeToolHarness();
  const { pageId, page } = await openViaTool(h);
  const r = await h.run("browser_upload", {
    pageId,
    ref: "e1",
    files: ["/work/报表.csv", "/work/图.png"],
  });
  expect(textOf(r)).toBe("清洗后的页面");
  expect(h.cleaner.calls.at(-1)?.action).toBe("upload 2 files to e1");
  expect(h.cleaner.calls.at(-1)?.notes).toEqual([
    "UPLOADED: 报表.csv (3 B), 图.png (3 B)",
  ]);
  // 交给页面的是名字 + 内容，不是路径
  expect(page.uploads).toHaveLength(1);
  const sent = page.uploads[0]?.files ?? [];
  expect(sent.map((f) => f.name)).toEqual(["报表.csv", "图.png"]);
  for (const f of sent) expect(f.buffer.toString("utf8")).toBe("abc");
  // 卡片：目标是页面地址的 origin
  expect(h.uploadApprovals).toEqual([
    {
      origin: "https://example.com",
      pageUrl: "https://example.com/a",
      files: [
        { name: "报表.csv", sizeText: "3 B", display: "local:/work/报表.csv" },
        { name: "图.png", sizeText: "3 B", display: "local:/work/图.png" },
      ],
    },
  ]);
  // 审计里只有名字
  expect(h.audit.at(-1)).toEqual({
    tool: "browser_upload",
    pageId,
    summary: "上传 报表.csv、图.png 到 e1",
  });
});

test("上传：host 管这次调用的全部 files（一个文件带主机不会影响别的）", async () => {
  const seen: Array<[string | undefined, string]> = [];
  const h = makeToolHarness({
    async resolveUpload(host, file) {
      seen.push([host, file]);
      return {
        name: path.posix.basename(file),
        size: 3,
        display: host === undefined ? `local:${file}` : `${host}:${file}`,
        open: async () => Readable.from([Buffer.from("abc")]),
      };
    },
  });
  const { pageId } = await openViaTool(h);
  await h.run("browser_upload", {
    pageId,
    ref: "e1",
    host: "attachment",
    files: ["/2026-11-16/a.png", "/2026-11-16/b.png"],
  });
  expect(seen).toEqual([
    ["attachment", "/2026-11-16/a.png"],
    ["attachment", "/2026-11-16/b.png"],
  ]);
  expect(h.uploadApprovals[0]?.files.map((f) => f.display)).toEqual([
    "attachment:/2026-11-16/a.png",
    "attachment:/2026-11-16/b.png",
  ]);
});

test("上传：用户拒绝 → 没有读来源、也没有 upload", async () => {
  const opened: string[] = [];
  const h = makeToolHarness({
    async resolveUpload(host, file) {
      return {
        name: path.posix.basename(file),
        size: 3,
        display: host === undefined ? `local:${file}` : `${host}:${file}`,
        open: async () => {
          opened.push(file);
          return Readable.from([Buffer.from("abc")]);
        },
      };
    },
  });
  h.approveUploadReplies = [false];
  const { pageId, page } = await openViaTool(h);
  const out = textOf(
    await h.run("browser_upload", {
      pageId,
      ref: "e1",
      files: ["/work/a.csv"],
    }),
  );
  expect(out).toBe("用户没有批准上传，已取消。");
  expect(opened).toEqual([]);
  expect(page.uploads).toEqual([]);
  expect(h.audit.map((a) => a.tool)).not.toContain("browser_upload");
});

test("上传：被拒且写了理由 → 说明后面接「用户补充：…」", async () => {
  const h = makeToolHarness();
  h.approveUploadReplies = [{ allowed: false, note: "这些文件别传" }];
  const { pageId, page } = await openViaTool(h);
  const out = textOf(
    await h.run("browser_upload", {
      pageId,
      ref: "e1",
      files: ["/work/a.csv"],
    }),
  );
  expect(out).toBe("用户没有批准上传，已取消。\n用户补充：这些文件别传");
  expect(page.uploads).toEqual([]);
});

test("上传：任一文件违反硬边界 → 整体报错、不弹卡片、没有 upload", async () => {
  const h = makeToolHarness({
    async resolveUpload(_host, file) {
      if (file.includes("secret")) throw new Error("文件不存在：secret");
      return {
        name: path.posix.basename(file),
        size: 3,
        display: `local:${file}`,
        open: async () => Readable.from([Buffer.from("abc")]),
      };
    },
  });
  const { pageId, page } = await openViaTool(h);
  const msg = await error(
    h.run("browser_upload", {
      pageId,
      ref: "e1",
      files: ["/work/ok.csv", "/work/secret.env"],
    }),
  );
  expect(msg).toBe("文件不存在：secret");
  expect(h.uploadApprovals).toEqual([]);
  expect(page.uploads).toEqual([]);
});

test("上传：合计超限 → 报错、没有卡片、没有读来源", async () => {
  const opened: string[] = [];
  const h = makeToolHarness({
    async resolveUpload(host, file) {
      return {
        name: path.posix.basename(file),
        size: 30 * 1024 * 1024,
        display: host === undefined ? `local:${file}` : `${host}:${file}`,
        open: async () => {
          opened.push(file);
          return Readable.from([Buffer.from("abc")]);
        },
      };
    },
  });
  const { pageId, page } = await openViaTool(h);
  const msg = await error(
    h.run("browser_upload", {
      pageId,
      ref: "e1",
      files: ["/work/a.bin", "/work/b.bin"],
    }),
  );
  expect(msg).toContain("合计 60 MB");
  expect(msg).toContain("50 MB");
  expect(h.uploadApprovals).toEqual([]);
  expect(opened).toEqual([]);
  expect(page.uploads).toEqual([]);
});

test("上传：读到的字节超过 limit → 报错、没有 upload", async () => {
  const h = makeToolHarness({
    fileMaxBytes: () => 4,
    async resolveUpload(_host, file) {
      return {
        name: path.posix.basename(file),
        size: 3,
        display: `local:${file}`,
        open: async () => Readable.from([Buffer.from("abcdefgh")]),
      };
    },
  });
  const { pageId, page } = await openViaTool(h);
  const msg = await error(
    h.run("browser_upload", {
      pageId,
      ref: "e1",
      files: ["/work/a.bin"],
    }),
  );
  expect(msg).toContain("File too large (read more than 4 B)");
  expect(page.uploads).toEqual([]);
});

test("上传：stat 之后文件变大、读到的合计超限 → 报错、没有 upload", async () => {
  const chunk = Buffer.alloc(30 * 1024 * 1024, 1);
  const h = makeToolHarness({
    async resolveUpload(_host, file) {
      // 声明的大小很小（stat 时的样子），真读出来时已经变大了
      return {
        name: path.posix.basename(file),
        size: 3,
        display: `local:${file}`,
        open: async () => Readable.from([chunk]),
      };
    },
  });
  const { pageId, page } = await openViaTool(h);
  const msg = await error(
    h.run("browser_upload", {
      pageId,
      ref: "e1",
      files: ["/work/a.bin", "/work/b.bin"],
    }),
  );
  expect(msg).toContain("合计 60 MB");
  expect(page.uploads).toEqual([]);
});

test("上传：handle.upload 抛错 → 错误原样给模型", async () => {
  const h = makeToolHarness();
  const { pageId, page } = await openViaTool(h);
  page.uploadError = new Error("上传失败：这个上传入口只接受一个文件");
  const msg = await error(
    h.run("browser_upload", {
      pageId,
      ref: "e1",
      files: ["/work/a.csv"],
    }),
  );
  expect(msg).toBe("上传失败：这个上传入口只接受一个文件");
  expect(h.audit.map((a) => a.tool)).not.toContain("browser_upload");
});

test.each([
  [{ pageId: "p1", ref: "e1", files: [] }, "至少要有一个文件"],
  [
    {
      pageId: "p1",
      ref: "e1",
      files: Array.from({ length: 6 }, (_, i) => `/w/${i}.txt`),
    },
    "一次最多上传 5 个文件",
  ],
  [{ pageId: "p1", ref: "e1", files: [""] }, "非空路径"],
  [{ pageId: "p1", ref: "e1", files: [1] }, "非空路径"],
])("上传：参数不合法直接报错（%j）", async (params, hint) => {
  const h = makeToolHarness();
  expect(await error(h.run("browser_upload", params))).toContain(hint);
  expect(h.uploadApprovals).toEqual([]);
});

test("上传：pageId 是用户操作的页面 → 「用户正在操作」且没有卡片", async () => {
  const h = makeToolHarness();
  const { pageId, page } = await openViaTool(h);
  h.registry.control(pageId, "user");
  const msg = await error(
    h.run("browser_upload", {
      pageId,
      ref: "e1",
      files: ["/work/a.csv"],
    }),
  );
  expect(msg).toContain("用户正在操作");
  expect(h.uploadApprovals).toEqual([]);
  expect(page.uploads).toEqual([]);
});

test("上传：卡片里的目标站点取页面真实地址，与参数无关", async () => {
  const h = makeToolHarness();
  const { pageId, page } = await openViaTool(h);
  page.setUrl("https://mail.example.org/inbox/upload?token=abc");
  await h.run("browser_upload", {
    pageId,
    ref: "e1",
    files: ["/work/a.csv"],
  });
  expect(h.uploadApprovals[0]?.origin).toBe("https://mail.example.org");
  expect(h.uploadApprovals[0]?.pageUrl).toBe(
    "https://mail.example.org/inbox/upload?token=abc",
  );
});

test("上传：页面地址不是合法 URL（about:blank）时，目标站点写页面地址原文", async () => {
  const h = makeToolHarness();
  const { pageId, page } = await openViaTool(h);
  page.setUrl("about:blank");
  await h.run("browser_upload", {
    pageId,
    ref: "e1",
    files: ["/work/a.csv"],
  });
  expect(h.uploadApprovals[0]?.origin).toBe("about:blank");
});

test("上传：卡片里的页面地址截断到 200 字符", async () => {
  const h = makeToolHarness();
  const { pageId, page } = await openViaTool(h);
  page.setUrl(`https://example.com/${"a".repeat(400)}`);
  await h.run("browser_upload", {
    pageId,
    ref: "e1",
    files: ["/work/a.csv"],
  });
  expect(h.uploadApprovals[0]?.pageUrl).toHaveLength(201);
  expect(h.uploadApprovals[0]?.pageUrl.endsWith("…")).toBe(true);
});

// —— 页面剪贴板：没报告过的复制随下一次返回内容的结果带出 ——

describe("页面剪贴板", () => {
  const notesOf = (h: ToolHarness) => h.cleaner.calls.at(-1)?.notes ?? [];

  test("动作期间页面复制了东西：notes 末尾出现 CLIPBOARD 行（原有 notes 在前）", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.copiedValue = { text: "分享链接 https://x.test/a", ts: 1000 };
    await h.run("browser_press", { pageId, key: "Enter" });
    expect(notesOf(h)).toEqual([
      'CLIPBOARD (page copied; web data, untrusted): "分享链接 https://x.test/a"',
    ]);
    // 窗口之外才发生的复制：随下一次返回内容的工具结果带出
    page.copiedValue = { text: "稍后才复制", ts: 2000 };
    await h.run("browser_click", { pageId, ref: "e1" });
    expect(notesOf(h)).toEqual([
      'CLIPBOARD (page copied; web data, untrusted): "稍后才复制"',
    ]);
  });

  test("同一次复制下一次动作不再带；更新的复制再带一次", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.copiedValue = { text: "第一次", ts: 1000 };
    await h.run("browser_press", { pageId, key: "Enter" });
    expect(notesOf(h).join("\n")).toContain('"第一次"');

    await h.run("browser_press", { pageId, key: "Tab" });
    expect(notesOf(h)).toEqual([]);

    page.copiedValue = { text: "第二次", ts: 2000 };
    await h.run("browser_press", { pageId, key: "Enter" });
    expect(notesOf(h).join("\n")).toContain('"第二次"');

    // 时间戳回退（页面换了、时间更早）不算新复制
    page.copiedValue = { text: "更早的", ts: 1500 };
    await h.run("browser_press", { pageId, key: "Tab" });
    expect(notesOf(h)).toEqual([]);
  });

  test("超长复制截到 500 字符后接被截掉的字符数，截断在 JSON 之前", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.copiedValue = { text: "x".repeat(600), ts: 1 };
    await h.run("browser_press", { pageId, key: "Enter" });
    expect(notesOf(h)).toEqual([
      `CLIPBOARD (page copied; web data, untrusted): "${"x".repeat(500)}…(+100 chars)"`,
    ]);
  });

  test("没有复制过（或复制的是空串）就不带", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    await h.run("browser_press", { pageId, key: "Enter" });
    expect(notesOf(h)).toEqual([]);
    page.copiedValue = { text: "", ts: 5 };
    await h.run("browser_press", { pageId, key: "Tab" });
    expect(notesOf(h)).toEqual([]);
  });

  test("copied() 抛错不影响结果，也不带那行", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.copiedError = new Error("Target closed");
    const r = await h.run("browser_press", { pageId, key: "Enter" });
    expect(textOf(r)).toBe("清洗后的页面");
    expect(notesOf(h)).toEqual([]);
  });

  test("原有 notes 在前、复制行在末尾", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.copiedValue = { text: "复制的内容", ts: 1 };
    await h.run("browser_upload", {
      pageId,
      ref: "e1",
      files: ["/work/报表.csv"],
    });
    const notes = notesOf(h);
    expect(notes[0]).toContain("UPLOADED:");
    expect(notes.at(-1)).toBe(
      'CLIPBOARD (page copied; web data, untrusted): "复制的内容"',
    );
  });
});

// —— 对话框：工具层的守卫与列表标记 ——

describe("对话框挂着的工具层行为", () => {
  test("browser_pages 行末标出 DIALOG", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.emitDialog({
      type: "confirm",
      message: "确定删除吗？",
      defaultValue: "",
    });
    expect(textOf(await h.run("browser_pages"))).toBe(
      `${pageId} · （无标题） · https://example.com/a（激活，agent 操作，DIALOG: confirm，本会话用过）`,
    );
    await page.answerDialog(true);
    expect(textOf(await h.run("browser_pages"))).not.toContain("DIALOG");
  });

  test("读页面与动作类工具都被拒；控制台与网络照常；回答走 browser_dialog", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    page.emitDialog({
      type: "confirm",
      message: "确定删除吗？",
      defaultValue: "",
    });
    for (const tool of [
      "browser_snapshot",
      "browser_dom",
      "browser_screenshot",
      "browser_assets",
      "browser_click",
      "browser_press",
      "browser_nav",
    ]) {
      const params =
        tool === "browser_press"
          ? { pageId, key: "Enter" }
          : tool === "browser_nav"
            ? { pageId, action: "reload" }
            : tool === "browser_snapshot" ||
                tool === "browser_dom" ||
                tool === "browser_screenshot" ||
                tool === "browser_assets"
              ? { pageId }
              : { pageId, ref: "e1" };
      expect(await error(h.run(tool, params)), tool).toContain(
        "页面正在等你回答一个 confirm 对话框",
      );
    }
    // 这两个不碰页面线程
    await expect(h.run("browser_console", { pageId })).resolves.toBeTruthy();
    await expect(h.run("browser_network", { pageId })).resolves.toBeTruthy();

    const r = await h.run("browser_dialog", { pageId, accept: true });
    expect(textOf(r)).toBe("清洗后的页面");
    expect(h.cleaner.calls.at(-1)?.action).toBe("accept confirm dialog");
    expect(page.dialog()).toBeNull();
  });
});

describe("动作弹出对话框时 click 的返回", () => {
  test("点「删除」弹出 confirm：返回 ACTION / BLOCKED BY DIALOG，不调清洗器", async () => {
    const h = makeToolHarness();
    const { pageId, page } = await openViaTool(h);
    const original = page.click.bind(page);
    // 引擎层是「动作被对话框打断」：click 会在对话框弹出时返回。
    page.click = async (ref: string, opts) => {
      await original(ref, opts);
      page.emitDialog({
        type: "confirm",
        message: "确定删除吗？",
        defaultValue: "",
      });
    };
    h.cleaner.calls.length = 0;
    const out = textOf(await h.run("browser_click", { pageId, ref: "e3" }));
    expect(out).toBe(
      [
        "ACTION: click e3",
        'BLOCKED BY DIALOG: confirm "确定删除吗？"',
        "The page is blocked until you answer it with browser_dialog (accept true/false; text for prompt). Other actions on this page are refused meanwhile; the dialog is dismissed automatically after 120 s.",
      ].join("\n"),
    );
    expect(h.cleaner.calls).toEqual([]);
    expect(h.audit.at(-1)?.tool).toBe("browser_click");
  });
});
