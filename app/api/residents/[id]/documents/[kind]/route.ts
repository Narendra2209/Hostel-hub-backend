/**
 * /api/residents/[id]/documents/[kind]   (kind = photo | aadhaar)
 *
 *   POST   -> upload a photo or Aadhaar document  (multipart/form-data, ADMIN)
 *   GET    -> stream the stored bytes back        (VIEWER)
 *   DELETE -> forget the document                 (ADMIN)
 *
 * This one route replaces the whole S3 presign/confirm/signed-URL dance. GridFS
 * lives in the same cluster as the rest of the data, so there is no third party
 * to hand temporary credentials to: the browser posts the file here, and reads
 * it back from here.
 *
 * The GET is what an <img src> points at. An <img> tag cannot send an
 * Authorization header, so this endpoint has to authorise from the session
 * cookie - and it does: `defineRoute` calls `requireAuth`, which calls
 * `extractToken`, which falls back to the `hostel_session` cookie when there is
 * no bearer header (lib/auth/jwt.ts). The cookie is HttpOnly and SameSite=Lax,
 * so this works whenever the app and the API are same-site; a cross-site
 * deployment must fetch the bytes with the bearer token and render a blob URL
 * instead, which the CORS headers below allow.
 *
 * Nothing here logs a URL, a file id or a byte of content.
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { DocumentKind } from '@hostel/shared';
import { defineRoute, optionsHandler, parseIdParam } from '@/lib/http/handler';
import { corsHeaders } from '@/lib/http/headers';
import { noContent, ok } from '@/lib/http/response';
import { ValidationError } from '@/lib/errors/app-error';
import { validateUpload, type DocumentPayload } from '@/lib/storage/gridfs';
import {
  getResidentDocument,
  maxDocumentBytes,
  parseDocumentKind,
  removeResidentDocument,
  uploadResidentDocument,
  type UploadedFile,
} from '@/lib/services/document.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DocumentParams = { id: string; kind: string };
type DocumentSegment = { params: Promise<DocumentParams> } | { params: DocumentParams };
type DocumentRoute = (
  request: NextRequest,
  segment?: DocumentSegment,
) => Promise<NextResponse>;

export const OPTIONS = optionsHandler;

/* ------------------------------------------------------------------ *
 * POST - upload
 * ------------------------------------------------------------------ */

/**
 * Pull the file out of the multipart body.
 *
 * The declared size is checked BEFORE the body is buffered, so an oversized
 * upload is rejected without materialising it in Lambda's memory; the storage
 * layer checks the real length again once the buffer exists.
 */
async function readUploadedFile(request: NextRequest, kind: DocumentKind): Promise<UploadedFile> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ValidationError('That upload could not be read', {
      file: ['Send the file as multipart/form-data'],
    });
  }

  const entry = form.get('file');
  if (entry === null || typeof entry === 'string') {
    throw new ValidationError('No file was uploaded', { file: ['Choose a file to upload'] });
  }

  // Browsers append the charset to some types; the storage layer compares
  // against bare mime types.
  const contentType = (entry.type.split(';')[0] ?? '').trim().toLowerCase();
  validateUpload(kind, contentType, entry.size);

  return {
    buffer: Buffer.from(await entry.arrayBuffer()),
    contentType,
    // Kept only so the storage layer can note the extension; it never becomes a
    // path, a header or a stored name.
    fileName: entry.name,
  };
}

let cachedUploadRoute: DocumentRoute | null = null;

/**
 * The upload route is built on first use rather than at import.
 *
 * `maxBodyBytes` has to come from MAX_UPLOAD_MB - the default 1 MB cap would
 * 413 every real photograph before the handler ever ran - but `env()` throws
 * when the environment is not configured, and `next build` imports this module
 * to collect page data. Building the handler lazily keeps configuration out of
 * build time, exactly as the Prisma client does.
 */
function uploadRoute(): DocumentRoute {
  if (!cachedUploadRoute) {
    cachedUploadRoute = defineRoute<DocumentParams>(
      // Uploads are far heavier than a JSON write, so they cost more budget.
      { role: 'ADMIN', maxBodyBytes: maxDocumentBytes(), rateLimitWeight: 5 },
      async ({ request, params, auth, origin }) => {
        const residentId = parseIdParam(params);
        const kind = parseDocumentKind(params);
        const file = await readUploadedFile(request, kind);
        const resident = await uploadResidentDocument(residentId, kind, file, auth);
        return ok(resident, { origin });
      },
    );
  }
  return cachedUploadRoute;
}

export const POST: DocumentRoute = (request, segment) => uploadRoute()(request, segment);

/* ------------------------------------------------------------------ *
 * GET - stream
 * ------------------------------------------------------------------ */

function documentResponse(document: DocumentPayload, origin: string | null): NextResponse {
  const headers = new Headers(corsHeaders(origin));
  // The stored type is authoritative - it is whatever was validated on upload -
  // and `nosniff` stops the browser from deciding otherwise.
  headers.set('Content-Type', document.contentType);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Length', String(document.body.byteLength));
  // An identity document: no shared cache, no disk cache, no history reuse.
  headers.set('Cache-Control', 'private, no-store');
  // Displayed in place; never saved under a name the uploader chose.
  headers.set('Content-Disposition', 'inline');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  // CORP is only enforced for no-cors loads, so this still permits the
  // same-site <img> above while blocking an embed from an unrelated site.
  headers.set('Cross-Origin-Resource-Policy', 'same-site');

  // A Buffer sits on Node's shared allocation pool, which `BodyInit` will not
  // take; copying into a standalone Uint8Array both satisfies the type and
  // guarantees the response body owns its own memory.
  return new NextResponse(new Uint8Array(document.body), { status: 200, headers });
}

export const GET = defineRoute<DocumentParams>({ role: 'VIEWER' }, async ({ params, origin }) => {
  const residentId = parseIdParam(params);
  const kind = parseDocumentKind(params);
  const document = await getResidentDocument(residentId, kind);
  return documentResponse(document, origin);
});

/* ------------------------------------------------------------------ *
 * DELETE
 * ------------------------------------------------------------------ */

export const DELETE = defineRoute<DocumentParams>(
  { role: 'ADMIN' },
  async ({ params, auth, origin }) => {
    const residentId = parseIdParam(params);
    const kind = parseDocumentKind(params);
    await removeResidentDocument(residentId, kind, auth);
    return noContent({ origin });
  },
);
