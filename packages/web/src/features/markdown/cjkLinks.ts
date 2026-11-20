// 自动识别的链接（正文里直接写的网址）遇到中文标点就在那里收尾：
// GFM 只认英文标点，「见 网址，然后」里的「，然后」也会被吞进链接。
// 网址里本来就有的汉字（如中文维基的条目名）保留，只在中文标点处截断。
interface MdNode {
  type: string;
  url?: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number | undefined } };
}

// 全角标点与符号（，。；：！？（）【】《》「」、）、弯引号、省略号、破折号
const CJK_PUNCT = /[　-〿＀-￯‘-”…—]/;

/** 自动识别的链接：文字就是地址本身（`[文字](地址)` 与 `<地址>` 不动）。 */
const literalText = (link: MdNode, source: string): MdNode | null => {
  const [text] = link.children ?? [];
  const start = link.position?.start.offset;
  if (
    link.children?.length !== 1 ||
    text?.type !== "text" ||
    start === undefined
  )
    return null;
  return source.startsWith(text.value ?? "", start) ? text : null;
};

const trimLink = (link: MdNode, source: string): MdNode | null => {
  const text = literalText(link, source);
  if (!text?.value || !link.url) return null;
  const cut = text.value.search(CJK_PUNCT);
  if (cut <= 0) return null;
  const tail = text.value.slice(cut);
  if (!link.url.endsWith(tail)) return null;
  text.value = text.value.slice(0, cut);
  link.url = link.url.slice(0, link.url.length - tail.length);
  return { type: "text", value: tail };
};

const walk = (node: MdNode, source: string): void => {
  const kids = node.children;
  if (!kids) return;
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i] as MdNode;
    if (kid.type !== "link") {
      walk(kid, source);
      continue;
    }
    const rest = trimLink(kid, source);
    if (rest) kids.splice(i + 1, 0, rest);
  }
};

export const remarkCjkLinks = () => (tree: MdNode, file: unknown) =>
  walk(tree, String(file));
