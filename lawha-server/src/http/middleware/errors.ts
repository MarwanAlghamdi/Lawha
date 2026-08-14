import { ZodError } from "zod";

import type { NextFunction, Request, Response } from "express";

/** An error whose message is safe to show a user. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    override readonly message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, code?: string): HttpError =>
  new HttpError(400, message, code);

export const unauthorized = (message = "Sign in to continue."): HttpError =>
  new HttpError(401, message, "UNAUTHENTICATED");

// `code` is optional on both, and defaulted rather than required, so every
// existing caller keeps the code the client already branches on. It exists for
// refusals the UI has to tell apart — an invite that expired and one that was
// revoked are both 403 and need different sentences (ADR 0014).
export const forbidden = (
  message = "You do not have access to this board.",
  code = "FORBIDDEN",
): HttpError => new HttpError(403, message, code);

export const notFound = (
  message = "Not found.",
  code = "NOT_FOUND",
): HttpError => new HttpError(404, message, code);

export const conflict = (message: string, code?: string): HttpError =>
  new HttpError(409, message, code);

export const tooManyRequests = (message: string): HttpError =>
  new HttpError(429, message, "RATE_LIMITED");

/**
 * The disk cannot hold what was asked for. 507 rather than 500 because this is
 * not a bug and the operator's next move is specific: free space, or point
 * LAWHA_DATA_DIR somewhere larger. A 500 here would send them reading logs for
 * a stack trace that does not exist.
 */
export const insufficientStorage = (message: string): HttpError =>
  new HttpError(507, message, "INSUFFICIENT_STORAGE");

/** Wraps an async handler so rejections reach the error middleware. */
export const asyncHandler =
  <T extends Request>(
    handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
  ) =>
  (req: T, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };

export const errorMiddleware = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }

  if (error instanceof ZodError) {
    const first = error.errors[0];
    res.status(400).json({
      error: first?.message ?? "Invalid request.",
      code: "VALIDATION",
      field: first?.path.join("."),
    });
    return;
  }

  // Unexpected: log server-side, return nothing that could leak internals.
  process.stderr.write(
    `lawha: unhandled error ${
      error instanceof Error ? error.stack : String(error)
    }\n`,
  );
  res.status(500).json({ error: "Something went wrong.", code: "INTERNAL" });
};
