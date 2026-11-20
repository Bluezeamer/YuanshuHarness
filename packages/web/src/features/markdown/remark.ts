// 所有 Markdown 渲染共用的 remark 插件：GFM，外加「单个换行就是换行」（Typora 的习惯，不用空一行）、
// 中文友好的强调（`**注意：**正文` 这类标点紧挨汉字的写法）与中文标点处收尾的自动链接。
// 对话、文件预览、笔记、画布卡片都从这里取，别各自再列一份，也别再用 CSS 去补换行。
import remarkBreaks from "remark-breaks";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import { remarkCjkLinks } from "./cjkLinks";

export const REMARK_PLUGINS = [
  remarkGfm,
  remarkCjkFriendly,
  remarkCjkLinks,
  remarkBreaks,
];
