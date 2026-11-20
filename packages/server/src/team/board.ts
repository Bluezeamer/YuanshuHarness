// 公告板（team.md §3）：团队根目录下的只追加文件。写入只能经 post，编号、时间与署名由框架加，
// 成员在正文里自己写署名或标题是被禁止的约定（开场说明里写明），格式因此不会漂移。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import path from "node:path";

const clock = (d: Date): string =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** 追加一条：`## #12 · 14:03 · backend → all` + 正文 */
export function appendEntry(
  file: string,
  seq: number,
  from: string,
  to: string,
  text: string,
  now = new Date(),
): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(
    file,
    `## #${seq} · ${clock(now)} · ${from} → ${to}\n${text.trim()}\n\n`,
  );
}

export function readBoard(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export interface BoardEntry {
  no: number;
  time: string;
  from: string;
  to: string;
  text: string;
}

/** 把板子拆成条目（界面用）；不是这个格式的块丢掉 */
export function parseEntries(board: string): BoardEntry[] {
  return board.split(/\n(?=## #\d+ · )/).flatMap((chunk): BoardEntry[] => {
    const m =
      /^## #(\d+) · (\d{2}:\d{2}) · (.+?) → (.+?)(?:\n([\s\S]*))?$/.exec(
        chunk.trim(),
      );
    if (!m) return [];
    return [
      {
        no: Number(m[1]),
        time: m[2] as string,
        from: m[3] as string,
        to: m[4] as string,
        text: (m[5] ?? "").trim(),
      },
    ];
  });
}

/** 最近 n 条原文（板子摘要不可用时附上） */
export function recentEntries(board: string, n: number): string {
  const entries = board.split(/\n(?=## #\d+ · )/).filter((e) => e.trim());
  return entries.slice(-n).join("\n").trim();
}

/** 新队接手一个已有板子的会话：旧板子改名保留，新队从空白开始 */
export function archiveBoard(file: string): void {
  if (!existsSync(file)) return;
  for (let i = 1; ; i++) {
    const to = file.replace(/\.md$/, `.${i}.md`);
    if (existsSync(to)) continue;
    renameSync(file, to);
    return;
  }
}
