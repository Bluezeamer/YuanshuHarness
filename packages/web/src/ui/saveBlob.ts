// 把已取到的内容交给浏览器另存。下载走带令牌的 fetch，不能直接用 <a href>。
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
