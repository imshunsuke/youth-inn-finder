export class AppError extends Error {
  constructor(message, { code = "INTERNAL_ERROR", status = 500, cause, details, retryable = false } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.statusCode = status;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
}

export function invalidInput(message, field) {
  return new AppError(message, {
    code: "INVALID_INPUT",
    status: 400,
    details: { field },
  });
}

export function upstreamError(message = "官网数据暂时无法获取，请稍后重试", options = {}) {
  return new AppError(message, { code: "UPSTREAM_ERROR", status: 502, retryable: true, ...options });
}
