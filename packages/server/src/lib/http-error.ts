/** 带 HTTP 状态的业务错误：状态跟着错误走，路由层只翻译、不查表。 */
export class HttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    // 额外的响应字段（如多技能候选）；由 toHttp 展开进响应体。
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}
