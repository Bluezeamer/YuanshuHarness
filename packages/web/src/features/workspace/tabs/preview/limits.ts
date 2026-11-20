// 预览的体积上限（产品定的阈值）：超过就不在浏览器里渲染，提示下载到本地查看。
// 解析类要整份读进内存再解析、内存会翻几倍，所以卡得最紧；几个 G 的 docx 直接解析必然卡死。
export const PARSE_MAX = 20 * 1024 * 1024;
export const TEXT_MAX = 5 * 1024 * 1024;
export const IMAGE_MAX = 5 * 1024 * 1024;
export const PDF_MAX = 100 * 1024 * 1024;

/** 超限时说清楚是哪一档，别只丢一句「太大」。 */
export const limitHint = (max: number): string =>
  `文件超过 ${Math.round(max / 1024 / 1024)} MB，这里不解析，请下载后本地查看。`;
