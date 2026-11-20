// Markdown 渲染：GFM（表格、任务列表、删除线）；mermaid 围栏交给共用渲染组件。
// 图片：给了 imageBase 就按它解析相对路径并显示（点击放大）；外链 http(s) 不加载（会向第三方发请求），
// 显示成可点开的「[图片：说明]」；没给 imageBase（画布卡片）一律是占位。
// 给了 onWikilink 就把 `[[…]]` 渲染成可点击的链接（笔记在 .canvas/ 里时才给）。
import { Children, isValidElement, type ReactNode, useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import {
  copyAsMarkdown,
  rehypeSourceRange,
  srcAttrs,
} from "../../../markdown/copySource";
import { ImageBlock } from "../../../markdown/ImageBlock";
import type { ImageBase } from "../../../markdown/imageRef";
import { Mermaid } from "../../../markdown/Mermaid";
import "../../../markdown/prose.css";
import { REMARK_PLUGINS } from "../../../markdown/remark";
import { linkWikilinks, WIKI_SCHEME, wikiTargetOf } from "./wikilinks";

const COMPONENTS = { pre: Pre, a: Link };
// 轻量：mermaid 围栏照普通代码块显示源码，不渲染图（画布上几十张卡片同屏，渲染图太重）
const LIGHT_COMPONENTS = { a: Link };

const REHYPE_PLUGINS = [rehypeSourceRange];

function Pre({ children, ...rest }: { children?: ReactNode }) {
  const src = srcAttrs(rest);
  const child = Children.toArray(children)[0];
  const props = isValidElement(child)
    ? (child.props as { className?: string; children?: ReactNode })
    : undefined;
  const lang = /language-(\w+)/.exec(props?.className ?? "")?.[1];
  if (lang !== "mermaid") return <pre {...src}>{children}</pre>;
  return (
    <div className="md-src" {...src}>
      <Mermaid
        code={String(props?.children ?? "").replace(/\n$/, "")}
        className="ws-pv-mermaid"
        errorClassName="ws-pv-mermaid-err"
      />
    </div>
  );
}

function ImgPlaceholder({ src, alt }: { src?: string; alt?: string }) {
  const label = `[图片：${alt || "无说明"}]`;
  if (/^https?:\/\//i.test(src ?? ""))
    return (
      <a
        className="ws-pv-img-ph t-mono"
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        title={`外部图片，不自动加载；点击在新标签打开：${src}`}
      >
        {label}
      </a>
    );
  return <span className="ws-pv-img-ph t-mono">{label}</span>;
}

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

// wikilink 地址不在默认放行的协议里：只放行它，其余照默认（javascript: 等仍被去掉）
const urlTransform = (url: string): string =>
  url.startsWith(WIKI_SCHEME) ? url : defaultUrlTransform(url);

export function MarkdownView({
  text,
  light = false,
  className = "ws-pv-md",
  onWikilink,
  imageBase,
}: {
  text: string;
  light?: boolean;
  /** 容器类：预览标签用默认的（带内边距与行宽上限），画布卡片自己给 */
  className?: string;
  /** 点 `[[目标]]`：目标相对 `.canvas/`；不给就不处理 wikilink（文字照原样显示）。调用方要保持引用稳定 */
  onWikilink?: (target: string) => void;
  /** 图片的相对地址相对于谁；不给图片就是占位。调用方要保持引用稳定 */
  imageBase?: ImageBase;
}) {
  const components = useMemo(() => {
    const img = ({ src, alt }: { src?: string; alt?: string }) =>
      imageBase && !/^https?:\/\//i.test(src ?? "") ? (
        <ImageBlock
          {...(src === undefined ? {} : { src })}
          {...(alt === undefined ? {} : { alt })}
          base={imageBase}
        />
      ) : (
        <ImgPlaceholder src={src} alt={alt} />
      );
    const base = { ...(light ? LIGHT_COMPONENTS : COMPONENTS), img };
    if (!onWikilink) return base;
    const open = onWikilink;
    return {
      ...base,
      a({ href, children }: { href?: string; children?: ReactNode }) {
        const target = wikiTargetOf(href);
        if (target === null) return <Link href={href}>{children}</Link>;
        return (
          <a
            href={href}
            title={target}
            onClick={(e) => {
              e.preventDefault();
              open(target);
            }}
          >
            {children}
          </a>
        );
      },
    };
  }, [light, onWikilink, imageBase]);
  return (
    <div
      className={`${className} md-prose t-doc`}
      // wikilink 会先改写原文，偏移对不上了：这种（画布笔记）不接管复制
      {...(onWikilink ? {} : { onCopy: (e) => copyAsMarkdown(e, text) })}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
        urlTransform={urlTransform}
      >
        {onWikilink ? linkWikilinks(text) : text}
      </ReactMarkdown>
    </div>
  );
}
