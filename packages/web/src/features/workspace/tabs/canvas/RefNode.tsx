// 项目文件引用：上方灰字标 `主机:路径`（可以引用别的主机上的文件，来源要一眼看出）。
// 图片显示图片（服务端缩成缩略图并缓存），视频 / 音频点了才播（不自动播放），markdown 渲染，
// 其余只显示图标与文件名；都只读，双击在预览标签里打开。
import type { NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import {
  canvasImageUrl,
  canvasMediaUrl,
  type FileInfo,
} from "../../../../api/canvas";
import { Button, FileTypeIcon } from "../../../../ui";
import { cx } from "../../../../ui/cx";
import { PlayIcon } from "../../../../ui/icons";
import { type FlowNode, keepsAspect, refLabel, refTitle } from "./model";
import { useNodeCtx } from "./nodeCtx";
import {
  CardMarkdown,
  Handles,
  NodeBody,
  NodeLabel,
  Resizer,
} from "./nodeParts";

function RefImage({
  id,
  file,
  host,
  info,
}: {
  id: string;
  file: string;
  host: string | undefined;
  info: FileInfo | null;
}) {
  const ctx = useNodeCtx();
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <div className="cv-muted t-aux cv-pad">
        图片太大或格式不支持，双击在预览里打开
      </div>
    );
  return (
    <img
      className="cv-img"
      src={canvasImageUrl(
        ctx.env,
        ctx.dir,
        file,
        info?.mtimeMs,
        ctx.mediaRev,
        host,
      )}
      alt={refTitle(file)}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      onLoad={(e) => {
        const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
        if (w > 0 && h > 0) ctx.fitImage(id, w / h);
      }}
    />
  );
}

/** 视频：平时只是一个「播放」按钮（不预读、不自动播放，远程主机上也不花流量），点了才加载并开始播 */
function RefVideo({
  id,
  file,
  host,
  info,
  name,
}: {
  id: string;
  file: string;
  host: string | undefined;
  info: FileInfo | null;
  name: string;
}) {
  const ctx = useNodeCtx();
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <div className="cv-muted t-aux cv-pad">
        这个视频浏览器播不了（格式或编码不支持）
      </div>
    );
  if (!playing)
    return (
      <div className="cv-filebody t-plain">
        <Button
          className="nodrag nopan"
          icon={<PlayIcon />}
          aria-label={`播放 ${name}`}
          onClick={() => setPlaying(true)}
        >
          播放
        </Button>
        <span className="cv-title">{name}</span>
      </div>
    );
  return (
    <>
      {/* 播放中的 <video> 要自己接鼠标（拖进度条、点播放），整张卡片没处可抓；上沿这一条没有 nodrag，抓它就能挪动 */}
      <div className="cv-vgrip" />
      {/* biome-ignore lint/a11y/useMediaCaption: 用户自己放进画布的视频，没有字幕轨可挂 */}
      <video
        className="cv-video nodrag nopan nowheel nokey"
        src={canvasMediaUrl(ctx.env, ctx.dir, file, info?.mtimeMs, host)}
        controls
        autoPlay
        preload="auto"
        onError={() => setFailed(true)}
        onLoadedMetadata={(e) => {
          const { videoWidth: w, videoHeight: h } = e.currentTarget;
          if (w > 0 && h > 0) ctx.fitImage(id, w / h);
        }}
      />
    </>
  );
}

/** 音频：带播放条，但不预读（点播放才开始请求） */
function RefAudio({
  file,
  host,
  info,
}: {
  file: string;
  host: string | undefined;
  info: FileInfo | null;
}) {
  const ctx = useNodeCtx();
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <div className="cv-muted t-aux cv-pad">
        这个音频浏览器播不了（格式或编码不支持）
      </div>
    );
  return (
    <div className="cv-filebody">
      {/* biome-ignore lint/a11y/useMediaCaption: 用户自己放进画布的音频，没有字幕轨可挂 */}
      <audio
        className="cv-audio nodrag nopan nowheel nokey"
        src={canvasMediaUrl(ctx.env, ctx.dir, file, info?.mtimeMs, host)}
        controls
        preload="none"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

export const RefNode = memo(function RefNode({
  id,
  data,
  selected,
}: NodeProps<FlowNode>) {
  const ctx = useNodeCtx();
  const unreachable = data.info?.unreachable === true;
  const missing = data.info !== null && !data.info.exists && !unreachable;
  const { head, name } = data.host
    ? refLabel(ctx.hostNameOf(data.host), ctx.dir, data.file, true)
    : refLabel(ctx.hostLabel, ctx.dir, data.file);
  const preview = data.info?.preview ?? "";
  const image = data.refKind === "image";
  const video = data.refKind === "video";

  return (
    <div
      className="cv-node cv-ref"
      data-selected={selected || undefined}
      data-missing={missing || undefined}
    >
      <Resizer selected={selected} keepAspectRatio={keepsAspect(data)} />
      <Handles />
      <NodeLabel>
        <span className="cv-labhead" title={`${head}${name}`}>
          {head}
        </span>
        <span className="cv-labname">{name}</span>
      </NodeLabel>
      <div className="cv-box">
        <NodeBody
          className={cx(
            (image || video) && "cv-imgbody",
            selected && !image && !video && "nowheel",
          )}
          data-cut={
            data.refKind === "markdown" && data.info?.truncated ? "" : undefined
          }
        >
          {unreachable ? (
            <div className="cv-muted t-aux cv-pad">
              主机未连接，连上后刷新画布
            </div>
          ) : missing ? (
            <div className="cv-muted t-aux cv-pad">文件缺失</div>
          ) : image ? (
            <RefImage
              id={id}
              file={data.file}
              host={data.host}
              info={data.info}
            />
          ) : video ? (
            <RefVideo
              id={id}
              file={data.file}
              host={data.host}
              info={data.info}
              name={name}
            />
          ) : data.refKind === "audio" ? (
            <RefAudio file={data.file} host={data.host} info={data.info} />
          ) : data.refKind === "markdown" && preview ? (
            <CardMarkdown text={preview} />
          ) : (
            <div className="cv-filebody t-plain">
              <FileTypeIcon name={name} size={16} />
              <span className="cv-title">{name}</span>
            </div>
          )}
        </NodeBody>
      </div>
    </div>
  );
});
