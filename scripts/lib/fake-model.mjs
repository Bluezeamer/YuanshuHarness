// 脚本化的假模型：本机起一个 OpenAI 兼容（chat/completions 流式）端点，按剧本逐轮回答，
// 让界面验收脚本在没有真实模型时也能得到「思考 → 工具调用 → 工具结果 → 正文」的完整对话。
//
// 剧本是数组，每个元素是模型的一轮回答：{ thinking?, text?, tools?: [{ name, args }], delay? }；某一轮写了 delay 就用它代替全局的。
// args 可以是函数 (messages) => 对象：拿到到这一轮为止的对话历史（含上一轮的工具结果），用来取运行时才有的值（如页面编号）。
// 带 tools 字段的请求才是主对话（会话标题这类辅助调用不带工具，一律回一句固定文字，不占剧本）。
// 第 N 个主对话请求拿第 N 轮；剧本用完后重复最后一轮。delay 是相邻两个流式块之间的毫秒数。
//
// 选项 aux：(请求体) => 文字 | null，让不带工具的辅助调用（页面阅读之类）回自定义内容；返回 null 仍回那句固定文字。
// 用法：const fake = await startFakeModel(script, { delay: 80 }); … fake.baseUrl … await fake.close();
import { createServer } from "node:http";

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pieces = (s, n) =>
  s === "" ? [] : s.match(new RegExp(`[\\s\\S]{1,${n}}`, "g"));

export async function startFakeModel(script, { delay = 0, aux } = {}) {
  let main = 0;
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", async () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const reqBody = JSON.parse(body || "{}");
      const isMain = Array.isArray(reqBody.tools) && reqBody.tools.length > 0;
      const turn = isMain
        ? script[Math.min(main++, script.length - 1)]
        : { text: aux?.(reqBody) ?? "测试对话" };
      seen.push({ main: isMain, turn, body: reqBody });
      const pause = () => sleep(turn.delay ?? delay);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const chunk = (delta, finish = null) =>
        sse(res, {
          id: "fake",
          object: "chat.completion.chunk",
          created: 0,
          model: reqBody.model ?? "fake",
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
      chunk({ role: "assistant", content: "" });
      for (const p of pieces(turn.thinking ?? "", 6) ?? []) {
        chunk({ reasoning_content: p });
        await pause();
      }
      for (const p of pieces(turn.text ?? "", 8) ?? []) {
        chunk({ content: p });
        await pause();
      }
      for (const [i, t] of (turn.tools ?? []).entries()) {
        chunk({
          tool_calls: [
            {
              index: i,
              id: `call_${main}_${i}`,
              type: "function",
              function: { name: t.name, arguments: "" },
            },
          ],
        });
        const args =
          typeof t.args === "function"
            ? t.args(reqBody.messages ?? [])
            : t.args;
        for (const p of pieces(JSON.stringify(args), 10) ?? []) {
          chunk({
            tool_calls: [{ index: i, function: { arguments: p } }],
          });
          await pause();
        }
      }
      chunk({}, turn.tools?.length ? "tool_calls" : "stop");
      sse(res, {
        id: "fake",
        object: "chat.completion.chunk",
        created: 0,
        model: reqBody.model ?? "fake",
        choices: [],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 80,
          total_tokens: 1280,
        },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: seen,
    close: () => new Promise((r) => server.close(r)),
  };
}
