#!/usr/bin/env node
// 提示词基线对比：把当前真实投影与 prompts/upstream/baseline 做逐项 diff。
//
// 用途：更换 pi 底座版本、或改了我们自己的注入后，跑一次就知道「模型看到的东西变了没有、变在哪」。
// 只对比最终投影，不读 pi 源码——这是项目的既定方法（见 AGENTS.md）。
//
// 用法：
//   node scripts/prompt-baseline.mjs            对比，有差异则退出码 1
//   node scripts/prompt-baseline.mjs --update   把当前投影写成新基线
//   node scripts/prompt-baseline.mjs --url http://127.0.0.1:7431
//
// 做法：建一个临时会话 → 发一条固定探针消息 → 取这次调用的请求体 →
// 从 messages[0] 抽系统提示、从 tools 抽声明，与基线逐字节/逐项比。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BASE = path.join(ROOT, "packages/server/prompts/upstream/baseline");

const args = process.argv.slice(2);
const update = args.includes("--update");
const urlAt = args.indexOf("--url");
const URL_ = urlAt >= 0 ? args[urlAt + 1] : "http://127.0.0.1:7431";

const PROBE =
  "只回复 ok 两个字，不要调用任何工具。（这是提示词基线探针，请勿执行其他动作）";

const post = async (p, body) => {
  const r = await fetch(`${URL_}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${p} → ${r.status} ${await r.text()}`);
  return r.json();
};
const get = async (p) => {
  const r = await fetch(`${URL_}${p}`);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按固定的 fixture 建会话：基线依赖环境，不钉住就永远对不上 */
async function newSession() {
  const fx = JSON.parse(readFileSync(path.join(BASE, "fixture.json"), "utf8"));
  const { directories } = await get("/api/v1/directories");
  const ws = (directories ?? []).find(
    (w) => w.name === fx.directory.name && w.path === fx.directory.path,
  );
  if (!ws)
    throw new Error(
      `找不到 fixture 指定的 directory：${fx.directory.name} @ ${fx.directory.path}`,
    );
  return post("/api/v1/sessions", {
    directoryId: ws.id,
    config: fx.config,
  });
}

async function capture() {
  const { id } = await newSession();
  const ws = new WebSocket(
    `${URL_.replace("http", "ws")}/api/v1/sessions/${id}/stream`,
    ["yuanshu.v1"],
  );
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const done = new Promise((res) => {
    ws.onmessage = (e) => {
      try {
        if (JSON.parse(e.data).type === "run.ended") res();
      } catch {}
    };
  });
  ws.send(
    JSON.stringify({ type: "send_message", id: `m${Date.now()}`, text: PROBE }),
  );
  await Promise.race([done, sleep(120_000)]);
  ws.close();

  const { calls } = await get(`/api/v1/sessions/${id}/calls`);
  const first = calls[calls.length - 1];
  const detail = await get(`/api/v1/sessions/${id}/calls/${first.id}`);

  const system = detail.request.messages.find(
    (m) => m.role === "developer" || m.role === "system",
  );
  const systemText =
    typeof system?.content === "string"
      ? system.content
      : (system?.content ?? []).map((b) => b.text ?? "").join("");
  return {
    systemText: systemText.trimEnd(),
    tools: detail.request.tools ?? [],
  };
}

const sectionOf = (text, name) => {
  const m = new RegExp(`^<${name}>\\n([\\s\\S]*?)\\n</${name}>`, "m").exec(
    text,
  );
  return m?.[1];
};

const lineDiff = (a, b) => {
  const la = a.split("\n");
  const lb = b.split("\n");
  const out = [];
  const max = Math.max(la.length, lb.length);
  for (let i = 0; i < max; i++)
    if (la[i] !== lb[i]) out.push({ line: i + 1, was: la[i], now: lb[i] });
  return out;
};

const main = async () => {
  const cur = await capture();
  console.log(
    `抓取完成：系统提示 ${cur.systemText.length} 字，工具 ${cur.tools.length} 个`,
  );

  if (update) {
    writeFileSync(path.join(BASE, "system.md"), `${cur.systemText}\n`);
    writeFileSync(
      path.join(BASE, "tools.declared.json"),
      `${JSON.stringify(cur.tools, null, 2)}\n`,
    );
    console.log("已写入新基线。请 review 差异后再提交。");
    return 0;
  }

  const oldSystem = readFileSync(
    path.join(BASE, "system.md"),
    "utf8",
  ).trimEnd();
  const oldTools = JSON.parse(
    readFileSync(path.join(BASE, "tools.declared.json"), "utf8"),
  );

  let bad = 0;

  // 段级
  const names = new Set([
    ...[...oldSystem.matchAll(/^<([a-z][a-z0-9_-]*)>$/gm)].map((m) => m[1]),
    ...[...cur.systemText.matchAll(/^<([a-z][a-z0-9_-]*)>$/gm)].map(
      (m) => m[1],
    ),
  ]);
  for (const n of names) {
    const a = sectionOf(oldSystem, n);
    const b = sectionOf(cur.systemText, n);
    if (a === b) continue;
    if (a === undefined || b === undefined) {
      console.log(`段 <${n}>：${a === undefined ? "新增" : "消失"}`);
      bad++;
      continue;
    }
    const d = lineDiff(a, b);
    console.log(`段 <${n}>：${d.length} 行差异`);
    for (const x of d.slice(0, 6)) {
      console.log(`  L${x.line}`);
      console.log(`    - ${JSON.stringify(x.was)?.slice(0, 160)}`);
      console.log(`    + ${JSON.stringify(x.now)?.slice(0, 160)}`);
    }
    bad++;
  }
  if (
    oldSystem.slice(0, oldSystem.indexOf("\n\n<")) !==
    cur.systemText.slice(0, cur.systemText.indexOf("\n\n<"))
  ) {
    console.log("preamble：不一致");
    bad++;
  }

  // 工具级
  const byName = (list) => new Map(list.map((t) => [t.function.name, t]));
  const a = byName(oldTools);
  const b = byName(cur.tools);
  for (const n of new Set([...a.keys(), ...b.keys()])) {
    const ta = a.get(n);
    const tb = b.get(n);
    if (!ta || !tb) {
      console.log(`工具 ${n}：${ta ? "消失" : "新增"}`);
      bad++;
      continue;
    }
    const da = JSON.stringify(ta);
    const db = JSON.stringify(tb);
    if (da === db) continue;
    if (ta.function.description !== tb.function.description) {
      console.log(`工具 ${n}：description 变了`);
      for (const x of lineDiff(
        ta.function.description ?? "",
        tb.function.description ?? "",
      ).slice(0, 4))
        console.log(
          `  - ${JSON.stringify(x.was)?.slice(0, 140)}\n  + ${JSON.stringify(x.now)?.slice(0, 140)}`,
        );
    }
    if (
      JSON.stringify(ta.function.parameters) !==
      JSON.stringify(tb.function.parameters)
    )
      console.log(`工具 ${n}：parameters 变了`);
    bad++;
  }

  if (bad === 0) {
    console.log("✅ 与基线一致");
    return 0;
  }
  console.log(`\n❌ ${bad} 处差异`);
  return 1;
};

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("失败：", err.message);
    process.exit(2);
  },
);
