/**
 * RFC 9457 problem details. Every error the API returns has the same shape,
 * a stable `type` URI a client can switch on, and a `request_id` that matches
 * the server log line for the request.
 */
export const PROBLEM_BASE = 'https://github.com/mizcausevic-dev/website-change-tracker/blob/main/docs/problems.md';

export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly slug: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly extra: Record<string, unknown>;
  readonly headers: Record<string, string>;
  constructor(status: number, slug: string, title: string, detail?: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    super(detail ?? title);
    this.status = status;
    this.slug = slug;
    this.title = title;
    this.detail = detail;
    this.extra = extra;
    this.headers = headers;
  }
}

export const problemType = (slug: string): string => `${PROBLEM_BASE}#${slug}`;

export function problemBody(err: ApiError, instance: string, requestId: string): Record<string, unknown> {
  return {
    type: problemType(err.slug),
    title: err.title,
    status: err.status,
    ...(err.detail ? { detail: err.detail } : {}),
    instance,
    request_id: requestId,
    ...err.extra,
  };
}

export const Problems = {
  notFound: (what: string, id?: string) => new ApiError(404, 'not-found', 'Resource not found', id ? `${what} ${id} does not exist.` : `${what} does not exist.`),
  validation: (errors: FieldError[]) => new ApiError(422, 'validation-error', 'Request body failed validation', `${errors.length} field error${errors.length === 1 ? '' : 's'}.`, { errors }),
  badParam: (name: string, message: string) => new ApiError(400, 'invalid-parameter', 'Invalid query parameter', `${name}: ${message}`, { errors: [{ field: name, message }] }),
  unauthenticated: (detail: string, error?: string) =>
    new ApiError(401, 'unauthenticated', 'Authentication required', detail, {}, { 'WWW-Authenticate': `Bearer realm="driftline"${error ? `, error="${error}"` : ''}` }),
  forbidden: (scope: string) =>
    new ApiError(403, 'insufficient-scope', 'API key lacks the required scope', `This operation requires the "${scope}" scope.`, { required_scope: scope }, {
      'WWW-Authenticate': `Bearer realm="driftline", error="insufficient_scope", scope="${scope}"`,
    }),
  conflict: (slug: string, title: string, detail: string, extra: Record<string, unknown> = {}) => new ApiError(409, slug, title, detail, extra),
};
