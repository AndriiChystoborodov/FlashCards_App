import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError, type ZodType } from 'zod';
import { idParam as idSchema } from './schemas.js';
import { ServiceError, type ErrorCode } from '../services/errors.js';

/** rest-api.md error shape: `{ error: { code, message } }`. Messages never include tokens or request headers. */
export type ApiCode = ErrorCode | 'unauthorized' | 'invalid_request' | 'internal';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiCode,
    message: string,
  ) {
    super(message);
  }
}

/** The code -> status table of docs/rest-api.md. */
export const STATUS: Record<ApiCode, number> = {
  invalid_request: 400, assessment_closed: 400, rating_required: 400, invalid_option: 400,
  unauthorized: 401,
  not_found: 404, internal: 500,
  course_not_draft: 409, course_not_active: 409, course_finished: 409, threshold_locked: 409, ends_at_shortened: 409, ends_at_passed: 409,
  no_cards: 409, not_open: 409, not_enrolled: 409, removed: 409, course_over: 409, sent_again: 409, duplicate: 409,
};

const body = (code: ApiCode, message: string) => ({ error: { code, message } });

/** zod 4: messages come from the issue text and the path, never from the input value (it could hold secrets). */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const msg = r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
  throw new HttpError(400, 'invalid_request', msg.slice(0, 400));
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json(body('not_found', 'No such route.'));
};

export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (err instanceof HttpError) return void res.status(err.status).json(body(err.code, err.message));
  if (err instanceof ServiceError) return void res.status(STATUS[err.code]).json(body(err.code, err.message));
  if (err instanceof ZodError) return void res.status(400).json(body('invalid_request', 'Invalid request.'));
  if (err instanceof URIError) return void res.status(404).json(body('not_found', 'Not found.')); // bad percent-encoding in a path: a malformed id
  const e = err as { status?: number; type?: string; code?: string };
  // body-parser: bad JSON, wrong content type, body too large
  if ((typeof e.status === 'number' && e.status >= 400 && e.status < 500 && typeof e.type === 'string') || e.code === 'Z_DATA_ERROR') {
    return void res.status(400).json(body('invalid_request', 'The request body is not valid JSON or is too large.'));
  }
  // Only names and codes are logged: driver messages carry query parameters.
  const cause = (err as { cause?: { message?: string } } | null)?.cause?.message;
  console.error('request failed', (err as Error | null)?.name, (err as { code?: string } | null)?.code, cause?.slice(0, 200));
  res.status(500).json(body('internal', 'Internal error.'));
};

/** Malformed ids are 404, the same answer as an unknown or foreign id. */
export function id(v: string | undefined): string {
  if (!idSchema.safeParse(v).success) throw new ServiceError('not_found', 'Not found.');
  return v!;
}
