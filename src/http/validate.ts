import type { Context } from 'hono';
import { ApiError, Problems, type FieldError } from './problem.ts';

const MAX_BODY = 64 * 1024;

/** Read and parse a JSON object body, enforcing media type, size, and syntax. */
export async function readJsonObject(c: Context, mediaTypes: string[] = ['application/json']): Promise<Record<string, unknown>> {
  const ctype = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!mediaTypes.includes(ctype)) {
    throw new ApiError(415, 'unsupported-media-type', 'Unsupported media type', `Send the body as ${mediaTypes.join(' or ')}.`, {}, mediaTypes.includes('application/merge-patch+json') ? { 'Accept-Patch': 'application/merge-patch+json' } : {});
  }
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BODY) throw new ApiError(413, 'payload-too-large', 'Request body too large', `Bodies are limited to ${MAX_BODY} bytes.`);
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > MAX_BODY) throw new ApiError(413, 'payload-too-large', 'Request body too large', `Bodies are limited to ${MAX_BODY} bytes.`);
  let parsed: unknown;
  try {
    parsed = raw.length ? JSON.parse(raw) : {};
  } catch (e) {
    throw new ApiError(400, 'malformed-json', 'Malformed JSON', (e as Error).message);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw Problems.validation([{ field: '(body)', message: 'must be a JSON object' }]);
  return parsed as Record<string, unknown>;
}

export interface FieldSpec {
  type: 'string' | 'integer' | 'boolean' | 'string[]';
  required?: boolean;
  nullable?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  maxItems?: number;
  itemMaxLength?: number;
  enum?: readonly string[];
  check?: (value: never) => string | null;
}
export type Spec = Record<string, FieldSpec>;

/**
 * Validates `body` against `spec`. Unknown fields are rejected rather than
 * ignored: a typo such as `min_signficance` should fail loudly, not silently
 * fall back to the default. With `partial`, `required` is not enforced.
 */
export function validate(body: Record<string, unknown>, spec: Spec, partial = false): { value: Record<string, unknown>; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const value: Record<string, unknown> = {};
  for (const k of Object.keys(body)) if (!(k in spec)) errors.push({ field: k, message: 'unknown field' });
  for (const [field, s] of Object.entries(spec)) {
    if (!(field in body)) {
      if (s.required && !partial) errors.push({ field, message: 'is required' });
      continue;
    }
    const v = body[field];
    if (v === null) {
      if (s.nullable) value[field] = null;
      else errors.push({ field, message: 'must not be null' });
      continue;
    }
    let err: string | null = null;
    switch (s.type) {
      case 'string':
        if (typeof v !== 'string') err = 'must be a string';
        else if (s.maxLength !== undefined && v.length > s.maxLength) err = `must be at most ${s.maxLength} characters`;
        else if (s.enum && !s.enum.includes(v)) err = `must be one of: ${s.enum.join(', ')}`;
        break;
      case 'integer':
        if (typeof v !== 'number' || !Number.isInteger(v)) err = 'must be an integer';
        else if (s.min !== undefined && v < s.min) err = `must be >= ${s.min}`;
        else if (s.max !== undefined && v > s.max) err = `must be <= ${s.max}`;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') err = 'must be a boolean';
        break;
      case 'string[]':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) err = 'must be an array of strings';
        else if (s.maxItems !== undefined && v.length > s.maxItems) err = `must have at most ${s.maxItems} items`;
        else if (s.itemMaxLength !== undefined && v.some((x: string) => x.length > s.itemMaxLength!)) err = `items must be at most ${s.itemMaxLength} characters`;
        else if (s.enum && v.some((x: string) => !s.enum!.includes(x))) err = `items must be one of: ${s.enum.join(', ')}`;
        break;
    }
    if (!err && s.check) err = s.check(v as never);
    if (err) errors.push({ field, message: err });
    else value[field] = v;
  }
  return { value, errors };
}

export function intParam(c: Context, name: string, def: number, min: number, max: number): number {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return def;
  if (!/^-?\d+$/.test(raw)) throw Problems.badParam(name, 'must be an integer');
  const n = Number(raw);
  if (n < min || n > max) throw Problems.badParam(name, `must be between ${min} and ${max}`);
  return n;
}

export function enumParam<T extends string>(c: Context, name: string, allowed: readonly T[]): T | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return undefined;
  if (!allowed.includes(raw as T)) throw Problems.badParam(name, `must be one of: ${allowed.join(', ')}`);
  return raw as T;
}

export function dateParam(c: Context, name: string): string | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return undefined;
  const t = Date.parse(raw);
  if (!Number.isFinite(t) || !/^\d{4}-\d{2}-\d{2}/.test(raw)) throw Problems.badParam(name, 'must be an RFC 3339 date-time');
  return new Date(t).toISOString();
}
