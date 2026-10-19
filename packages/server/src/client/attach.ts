import { createInterface, type Interface } from "node:readline";
import { ClientError, checkSession } from "./http.js";
import type { ClientOptions } from "./options.js";
import { type Frame, Renderer } from "./render.js";
import { type Ack, Stream } from "./stream.js";

export interface AttachIO {
  stdin: NodeJS.ReadableStream;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  // 触发即退出（码 0），不发 stop，会话继续运行。
  signal: AbortSignal;
}

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

export async function attach(
  opts: ClientOptions,
  id: string,
  io: AttachIO,
): Promise<number> {
  try {
    await checkSession(opts, id);
  } catch (err) {
    io.stderr.write(`yuanshu: ${(err as Error).message}\n`);
    return EXIT_FAILURE;
  }

  return new Promise<number>((resolve) => {
    const renderer = new Renderer();
    const commands = new Map<string, string>(); // 未收到 ack 的命令 id -> 类型
    let stream: Stream | undefined;
    let rl: Interface | undefined;
    let snapshotSeen = false;
    let done = false;
    let eof = false;
    let running = false;
    let queueLen = 0;
    // 已被接受但还没在事件流里看到效果的 send_message 条数（见 observe）。
    let owed = 0;

    const finish = (code: number) => {
      if (done) return;
      done = true;
      io.signal.removeEventListener("abort", onAbort);
      stream?.close();
      rl?.close();
      resolve(code);
    };
    const onAbort = () => finish(EXIT_OK);

    // EOF 之后：命令都有回应、发出的消息都已见到效果、会话空闲且队列为空，才算完。
    const maybeFinish = () => {
      if (
        eof &&
        commands.size === 0 &&
        owed === 0 &&
        !running &&
        queueLen === 0
      )
        finish(EXIT_OK);
    };

    const send = (type: string, extra?: Record<string, unknown>) => {
      if (!stream) return;
      commands.set(stream.command(type, extra), type);
    };

    const observe = (f: Frame) => {
      const d = f.data;
      switch (f.type) {
        case "snapshot":
          running = d.running === true;
          queueLen = Array.isArray(d.queue) ? d.queue.length : 0;
          // resync 期间丢掉的事件不会补发，已 ack 的消息的效果已含在快照里；只有仍未 ack 的才还欠。
          owed = [...commands.values()].filter(
            (t) => t === "send_message",
          ).length;
          break;
        case "run.started":
          running = true;
          owed = Math.max(0, owed - 1);
          break;
        case "run.ended":
          running = false;
          owed = 0;
          break;
        case "run.failed":
          owed = Math.max(0, owed - 1);
          break;
        case "queue.updated":
          queueLen = Array.isArray(d.queue) ? d.queue.length : 0;
          if (queueLen > 0) owed = Math.max(0, owed - 1);
          break;
      }
    };

    // /answer <编号或文本>：作答最早的待处理弹窗。
    const answer = (arg: string) => {
      const p = renderer.pendingPrompts[0];
      if (!p) return void io.stderr.write("没有待回答的弹窗\n");
      if (p.kind === "input")
        return send("answer_prompt", { promptId: p.promptId, text: arg });
      const opt = p.options[Number(arg) - 1];
      if (!opt) return void io.stderr.write("编号无效\n");
      send("answer_prompt", { promptId: p.promptId, optionId: opt.id });
    };

    const onLine = (line: string) => {
      const cmd = line.trim();
      if (cmd === "") return;
      if (cmd === "/quit") return finish(EXIT_OK);
      if (cmd === "/stop") return send("stop");
      if (cmd === "/answer" || cmd.startsWith("/answer "))
        return answer(cmd.slice("/answer".length).trim());
      owed += 1;
      send("send_message", { text: line });
    };

    // 快照到达之前不读输入：否则 EOF 会在不知道会话是否在运行时判定"空闲"。
    const startInput = () => {
      if (rl || !stream || !snapshotSeen || done) return;
      rl = createInterface({
        input: io.stdin,
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      rl.on("line", onLine);
      rl.on("close", () => {
        if (done) return;
        eof = true;
        maybeFinish();
      });
    };

    const onAck = (ack: Ack) => {
      const type = ack.id === undefined ? undefined : commands.get(ack.id);
      if (ack.id !== undefined) commands.delete(ack.id);
      if (!ack.ok) {
        io.stderr.write(`${ack.error?.message ?? "命令失败"}\n`);
        if (type === "send_message") owed = Math.max(0, owed - 1);
      }
      maybeFinish();
    };

    const onFrame = (f: Frame) => {
      const r = renderer.render(f);
      if (r.out) io.stdout.write(r.out);
      if (r.err) io.stderr.write(r.err);
      observe(f);
      if (f.type === "snapshot") {
        snapshotSeen = true;
        startInput();
      }
      maybeFinish();
    };

    if (io.signal.aborted) return resolve(EXIT_OK);
    io.signal.addEventListener("abort", onAbort, { once: true });

    Stream.open(
      opts.url,
      `/api/v1/sessions/${encodeURIComponent(id)}/stream`,
      opts.token,
      {
        onFrame,
        onAck,
        onClose: (code, reason) => {
          io.stderr.write(`连接已关闭：${code}${reason ? ` ${reason}` : ""}\n`);
          finish(EXIT_FAILURE);
        },
        onProtocolError: (message) => {
          io.stderr.write(`yuanshu: ${message}\n`);
          finish(EXIT_FAILURE);
        },
      },
    ).then(
      (s) => {
        stream = s;
        if (done) return s.close();
        startInput();
      },
      (err: unknown) => {
        io.stderr.write(
          `yuanshu: ${err instanceof ClientError ? err.message : "连接失败"}\n`,
        );
        finish(EXIT_FAILURE);
      },
    );
  });
}
