// bash 与后台任务的接线（subagent.md §3）：
//  - 阻塞调用：命令照常跑；到了提醒时间还没结束，这次调用先返回，命令转成后台任务继续跑；
//  - job_start 的内层调用：输出直接写进任务日志，随任务的信号中止。
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { JOB_REMIND_MAX_S } from "../store/defaults.js";
import type { JobManager } from "./manager.js";
import { detachedText } from "./messages.js";

/** 阻塞的 bash 到了提醒时间：exec 抛它，路由层把 message 当作普通结果返回给模型 */
export class Detached extends Error {}

/** 转后台之前缓存的输出上限，超出丢最早的 */
const KEEP_MAX = 4 * 1024 * 1024;

export interface JobBashOptions {
  jobs: JobManager;
  owner: string;
  /** 这次调用的提醒间隔（毫秒）；0 = 不转后台，一直阻塞到命令结束 */
  remindMs: number;
}

const labelOf = (command: string) =>
  (command.split("\n").find((l) => l.trim() !== "") ?? command).slice(0, 80);

export function jobBashOperations(
  inner: BashOperations,
  o: JobBashOptions,
): BashOperations {
  return {
    exec: async (command, cwd, io) => {
      // 工具的 timeout 已经从声明里去掉，这里也不再下传。
      const { timeout: _t, ...rest } = io;
      const job = o.jobs.current();
      if (job)
        return inner.exec(command, cwd, {
          ...rest,
          onData: (d) => {
            job.write(d);
            io.onData(d);
          },
        });
      if (o.remindMs <= 0) return inner.exec(command, cwd, rest);

      // 用自己的信号驱动命令：转后台之后外层调用的中止不该再杀它。
      const ours = new AbortController();
      const forward = () => ours.abort();
      if (io.signal?.aborted) ours.abort();
      else io.signal?.addEventListener("abort", forward, { once: true });

      let handle: ReturnType<JobManager["register"]> | undefined;
      const kept: Buffer[] = [];
      let size = 0;
      const startedAt = Date.now();
      const running = inner.exec(command, cwd, {
        ...rest,
        signal: ours.signal,
        onData: (d) => {
          if (handle) return handle.write(d);
          kept.push(d);
          size += d.length;
          while (size > KEEP_MAX && kept.length > 1)
            size -= (kept.shift() as Buffer).length;
          io.onData(d);
        },
      });
      let timer: NodeJS.Timeout | undefined;
      const first = await Promise.race([
        running.then(
          (r) => ({ r }),
          (e: unknown) => ({ e }),
        ),
        new Promise<"remind">((ok) => {
          timer = setTimeout(
            () => ok("remind"),
            Math.min(o.remindMs, JOB_REMIND_MAX_S * 1000),
          );
        }),
      ]);
      clearTimeout(timer);
      io.signal?.removeEventListener("abort", forward);
      if (first !== "remind") {
        if ("e" in first) throw first.e;
        return first.r;
      }

      const h = o.jobs.register(
        o.owner,
        {
          kind: "command",
          name: "bash",
          label: labelOf(command),
          // 变量替换之后的命令：机密值在进程环境里，不在命令文本里，可以直接存
          input: command,
          // 之后的提醒按这次调用给的间隔，已运行时间从命令最初开始算
          remindMs: o.remindMs,
          startedAt,
        },
        ours,
      );
      handle = h;
      h.write(Buffer.concat(kept));
      void running.then(
        (r) => h.end({ ok: r.exitCode === 0, exitCode: r.exitCode }),
        (e: unknown) =>
          h.end({
            ok: false,
            text: e instanceof Error ? e.message : String(e),
          }),
      );
      throw new Detached(
        detachedText(
          o.jobs.own(o.owner, h.id),
          o.jobs.tail(h.id, 20),
          Date.now() - startedAt,
        ),
      );
    },
  };
}
