export class AppError extends Error {
  constructor(options: {
    message: string;
    statusCode: number;
    code: string;
    detail?: Record<string, unknown>;
  }) {
    super(options.message);
    this.name = "AppError";
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.detail = options.detail;
  }

  readonly statusCode: number;
  readonly code: string;
  readonly detail?: Record<string, unknown>;
}
