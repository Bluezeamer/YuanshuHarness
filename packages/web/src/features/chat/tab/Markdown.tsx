import {
  Children,
  createContext,
  isValidElement,
  memo,
  type ReactNode,
  useContext,
  useRef,
} from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type UrlTransform,
} from "react-markdown";
import { hostIdOf } from "../../../app/shell/hosts";
import { CodeBlock } from "../../markdown/CodeBlock";
import { ImageBlock } from "../../markdown/ImageBlock";
import {
  ATTACHMENT_ENV,
  RefError,
  resolveImageTarget,
} from "../../markdown/imageRef";
import { MermaidBlock } from "../../markdown/MermaidBlock";
import "../../markdown/prose.css";
import { toast } from "../../../ui";
import {
  rehypeSourceRange,
  sourceRef,
  srcAttrs,
} from "../../markdown/copySource";
import { REMARK_PLUGINS } from "../../markdown/remark";
import { SessionIdContext } from "../../markdown/session";
import { useLayoutStoreOptional } from "../../workspace/layoutContext";
import { chatPaneOf } from "./chatPane";
import { saveAttachment } from "./download";

// 对话正文的 Markdown：GFM + 围栏块卡片 + 内嵌图片 + 可点的文件引用。
// 组件映射放在模块级：react-markdown 会把 components[tag] 直接当元素类型，
// 组件内联创建会让每次父组件重渲染都卸载重建整棵子树（流式时就是闪烁）。
const COMPONENTS = { pre: Pre, img: Img, a: Link };
// 用户消息不参与块渲染：代码保持原样、图片只留占位文字。
const PLAIN_COMPONENTS = { img: ImgRef };
const StreamingContext = createContext(false);

// file: 是我们自己的文件引用协议（图片与文件链接共用）；其余仍走 react-markdown 的默认清洗。
const urlTransform: UrlTransform = (url, key) =>
  (key === "src" || key === "href") && /^file:/i.test(url)
    ? url
    : defaultUrlTransform(url);

const REHYPE_PLUGINS = [rehypeSourceRange];

function Pre({ children, ...rest }: { children?: ReactNode }) {
  const streaming = useContext(StreamingContext);
  const src = srcAttrs(rest);
  const child = Children.toArray(children)[0];
  const props = isValidElement(child)
    ? (child.props as { className?: string; children?: ReactNode })
    : undefined;
  const lang = /language-([\w+#.-]+)/.exec(props?.className ?? "")?.[1];
  // 没有显式语言的围栏保持轻量 pre，不套卡片。
  if (!lang) return <pre {...src}>{children}</pre>;
  const code = String(props?.children ?? "").replace(/\n$/, "");
  return (
    <div className="md-src" {...src}>
      {lang === "mermaid" ? (
        <MermaidBlock code={code} streaming={streaming} />
      ) : (
        <CodeBlock code={code} lang={lang} streaming={streaming} />
      )}
    </div>
  );
}

function Img({ src, alt }: { src?: string; alt?: string }) {
  return <ImageBlock src={src} alt={alt} />;
}

function ImgRef({ alt }: { alt?: string }) {
  return <span className="ch-img-ref">[图片：{alt || "无说明"}]</span>;
}

// 回复里 `[名称](file:<主机>:<路径>)` 形式的文件引用：点开在文件预览标签里看。
// 不在目录内（独立测试/预览）时退化成普通文字，不给点了没反应的入口。
function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const store = useLayoutStoreOptional();
  const sessionId = useContext(SessionIdContext);
  const busy = useRef(false);
  const ref = /^file:/i.test(href ?? "") ? (href ?? "") : null;

  if (!ref || !store || !sessionId) return <a href={ref ?? href}>{children}</a>;

  const open = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const target = await resolveImageTarget(ref, sessionId);
      // 附件区的文件不在任何主机的文件树里：直接下载
      if (target.env === ATTACHMENT_ENV)
        return await saveAttachment(
          sessionId,
          `.${target.path}`,
          target.path.split("/").pop() || "attachment",
        );
      const at = chatPaneOf(store, sessionId);
      if (!at) return;
      store.openFilePreview(
        at.pid,
        at.tabId,
        hostIdOf(target.env),
        target.path,
      );
    } catch (e) {
      if (e instanceof RefError) toast(e.message, { tone: "danger" });
      else throw e;
    } finally {
      busy.current = false;
    }
  };
  // 外观与普通链接一样（.ch-md a）；href 留着是为了右键能复制引用，点击改走预览
  return (
    <a
      href={ref}
      title={`在预览里打开：${ref}`}
      onClick={(e) => {
        e.preventDefault();
        void open();
      }}
    >
      {children}
    </a>
  );
}

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  sessionId,
  plain = false,
}: {
  text: string;
  streaming?: boolean;
  /** 解析图片相对路径时用来定位会话 directory */
  sessionId?: string;
  /** 用户消息：不套块卡片、不渲染图片 */
  plain?: boolean;
}) {
  return (
    <SessionIdContext.Provider value={sessionId}>
      <StreamingContext.Provider value={streaming}>
        <div className="ch-md md-prose t-doc" ref={sourceRef(text)}>
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={plain ? PLAIN_COMPONENTS : COMPONENTS}
            urlTransform={plain ? undefined : urlTransform}
          >
            {text}
          </ReactMarkdown>
        </div>
      </StreamingContext.Provider>
    </SessionIdContext.Provider>
  );
});
