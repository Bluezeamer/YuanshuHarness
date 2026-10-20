// 把已取到的字节交给浏览器另存。下载走带令牌的 fetch，不能直接用 <a href>。
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export const baseName = (p: string) =>
  p.split("/").filter(Boolean).pop() ?? "/";

export const joinPath = (dir: string, name: string) =>
  dir === "/" ? `/${name}` : `${dir}/${name}`;

export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
