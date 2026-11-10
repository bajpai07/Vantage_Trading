/** An error that maps to one HTTP status and one stable machine-readable code. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Readonly<Record<string, string>>;
  constructor(
    status: number,
    code: string,
    message: string,
    headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const unauthenticated = (): AppError =>
  new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
