/**
 * The single response envelope every route handler returns.
 */
import { NextResponse } from 'next/server';
import type { ApiErrorBody, PaginationMeta } from '@hostel/shared';
import { corsHeaders, securityHeaders } from './headers';

function baseHeaders(origin: string | null, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  for (const [key, value] of Object.entries(securityHeaders())) headers.set(key, value);
  for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
  return headers;
}

export function ok<TData, TMeta = undefined>(
  data: TData,
  options: { meta?: TMeta; status?: number; origin?: string | null; headers?: HeadersInit } = {},
): NextResponse {
  const body: Record<string, unknown> = { success: true, data };
  if (options.meta !== undefined) body.meta = options.meta;
  return NextResponse.json(body, {
    status: options.status ?? 200,
    headers: baseHeaders(options.origin ?? null, options.headers),
  });
}

export const created = <TData>(
  data: TData,
  options: { origin?: string | null } = {},
): NextResponse => ok(data, { ...options, status: 201 });

export function noContent(options: { origin?: string | null } = {}): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: baseHeaders(options.origin ?? null),
  });
}

export function paginated<TItem, TMeta extends PaginationMeta>(
  items: TItem[],
  meta: TMeta,
  options: { origin?: string | null } = {},
): NextResponse {
  return ok(items, { meta, origin: options.origin ?? null });
}

export function failure(
  status: number,
  error: ApiErrorBody,
  options: { origin?: string | null; headers?: HeadersInit } = {},
): NextResponse {
  return NextResponse.json(
    { success: false, error },
    { status, headers: baseHeaders(options.origin ?? null, options.headers) },
  );
}

/** Build pagination metadata from a total count. */
export function buildPaginationMeta(
  page: number,
  pageSize: number,
  total: number,
): PaginationMeta {
  return {
    page,
    pageSize,
    total,
    totalPages: pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1,
  };
}

/** A CSV/JSON file download for the export endpoints. */
export function fileDownload(
  body: string,
  fileName: string,
  contentType: string,
  options: { origin?: string | null } = {},
): NextResponse {
  const headers = baseHeaders(options.origin ?? null);
  headers.set('Content-Type', `${contentType}; charset=utf-8`);
  headers.set('Content-Disposition', `attachment; filename="${fileName}"`);
  headers.set('Cache-Control', 'no-store');
  return new NextResponse(body, { status: 200, headers });
}
