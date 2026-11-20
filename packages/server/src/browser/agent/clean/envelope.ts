// 输出外壳（设计稿 §8.2 的固定英文结构）：标题、地址、动作、地址变化、附加行、快照编号，
// 然后才是内容。页面上的文字保持原文，外壳这几行用英文。
import { redactUrl } from "../../engine/console.js";

/** 标题与地址各截到多长：地址里的查询参数对主 agent 没用，长的部分截掉。 */
const TITLE_MAX = 120;
const URL_MAX = 300;

/** 标题去换行、截断；地址先打码再截断。 */
const titleOf = (title: string): string =>
  title.replace(/\s*\n\s*/g, " ").slice(0, TITLE_MAX) || "(untitled)";
const urlOf = (url: string): string => redactUrl(url).slice(0, URL_MAX);

/** 外壳（设计稿 §8.2）：固定的英文结构，页面上的文字保持原文 */
export function renderEnvelope(parts: {
  title: string;
  url: string;
  action?: string;
  urlChange?: { from: string; to: string };
  notes?: string[];
  /** 仅走完整路径的输出有：`s3 · 554 lines` */
  snapshot?: string;
  body: string;
}): string {
  const out = [`PAGE: ${titleOf(parts.title)} | ${urlOf(parts.url)}`];
  if (parts.action !== undefined && parts.action !== "")
    out.push(`ACTION: ${parts.action}`);
  if (parts.urlChange)
    out.push(
      `URL: ${urlOf(parts.urlChange.from)} → ${urlOf(parts.urlChange.to)}`,
    );
  for (const note of parts.notes ?? []) out.push(note);
  if (parts.snapshot !== undefined && parts.snapshot !== "")
    out.push(`SNAPSHOT: ${parts.snapshot}`);
  out.push(parts.body);
  return out.join("\n");
}
