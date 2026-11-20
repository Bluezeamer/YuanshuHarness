// 节点能用到的画布级能力。值由 CanvasFlow 提供：函数都是稳定引用，只有 editing 会变。
import { createContext, useContext } from "react";
import type { Done } from "./store";

export interface NodeCtx {
  env: string;
  dir: string;
  /** 画布所在主机的展示名：引用卡上方标注 `主机:路径` 用 */
  hostLabel: string;
  /** 环境 id → 主机展示名（别的主机上的引用标注用） */
  hostNameOf(envId: string): string;
  /** 图片设置的指纹：拼进图片地址 */
  mediaRev: string;
  /** 正在原地编辑的卡片的节点 id（保存前后不变，新卡片存成文件时路径会换） */
  editing: string | null;
  /** 把画布里的位置、大小、连线存进文档 */
  commitLayout(): void;
  startEdit(id: string): void;
  exitEdit(): void;
  /** 开始编辑一张卡片时取正文：有攒着没保存的接着改，新卡片是空的，其余读服务端的 */
  loadCard(file: string): Promise<Done<string>>;
  /** 编辑器里的正文变了（新卡片的 file 是占位名） */
  setText(file: string, text: string): void;
  /** 保存整张画布（Ctrl+S） */
  save(): void;
  /** 在预览里打开引用的文件；host 是别的主机上的引用所在的环境 id（file 此时是绝对路径） */
  openRef(file: string, host?: string): void;
  /** 刚放进来的图片：图片载入后按比例定节点高度（只做一次） */
  fitImage(id: string, ratio: number): void;
}

const Ctx = createContext<NodeCtx | null>(null);
export const NodeCtxProvider = Ctx.Provider;

export function useNodeCtx(): NodeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("画布节点必须在 NodeCtxProvider 里");
  return c;
}
