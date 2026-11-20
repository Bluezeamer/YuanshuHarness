// 目录变更通知：移动、传输、新建、删除之后，所有显示该环境的文件标签都要重新取目录，不只是动手的那个。

type Listener = (envId: string) => void;
const listeners = new Set<Listener>();

export const emitFsChange = (envId: string): void => {
  for (const l of [...listeners]) l(envId);
};

export function onFsChange(l: Listener): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}
