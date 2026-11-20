// SVG 渲染态：SVG 本身是文本，源码里能改；这里只是把它当图画出来。
// 用 blob URL 而不是内联 DOM：避免页面里的 <style>/脚本影响我们自己的 UI。
import { useEffect, useState } from "react";

export function SvgPreview({ text }: { text: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const blob = new Blob([text], { type: "image/svg+xml" });
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [text]);

  return <div className="ws-pv-svgb">{url && <img src={url} alt="SVG" />}</div>;
}
