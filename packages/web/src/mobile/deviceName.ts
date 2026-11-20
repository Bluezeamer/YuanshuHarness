// 配对页给设备名的预填：从 UA 里取机型（Android 的 UA 里有），取不到就叫「手机」。
export function defaultDeviceName(ua: string): string {
  const android = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(ua);
  const model = android?.[1]?.trim();
  if (model && model !== "K") return model.slice(0, 40);
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  return "手机";
}
