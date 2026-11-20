// 图片预览：基准是「窗格宽度与原尺寸里较小的那个」，Ctrl+滚轮的比例（--tab-zoom）乘在这个基准上。
// 不能用 max-width: 100% 加 CSS zoom：max-width 会把放大后的图一直封在窗格宽度，放大就没有效果。
import { type CSSProperties, useState } from "react";

export function ImageView({ src, alt }: { src: string; alt: string }) {
  const [natural, setNatural] = useState<number | null>(null);
  const style =
    natural === null ? undefined : ({ "--nat-w": natural } as CSSProperties);
  return (
    <div className="ws-pv-imgbox">
      <img
        src={src}
        alt={alt}
        style={style}
        onLoad={(e) => setNatural(e.currentTarget.naturalWidth)}
      />
    </div>
  );
}
