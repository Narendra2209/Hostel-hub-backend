/**
 * Resident documents (photo + Aadhaar card).
 *
 * Under PostgreSQL these files lived in a private S3 bucket and the browser
 * talked to it directly: presign -> PUT to S3 -> confirm -> short-lived signed
 * GET. On MongoDB the bytes live in GridFS inside the same cluster as
 * everything else, so all of that machinery is gone. There is nothing to
 * presign, no third party to grant temporary credentials to, and no object key
 * a client could tamper with:
 *
 *   uploadResidentDocument() -> multipart POST -> GridFS -> file id saved
 *   getResidentDocument()    -> the API streams the bytes back itself
 *   removeResidentDocument() -> pointer cleared, then the file dropped
 *
 * Security posture:
 *  - a client never names a file. `uploadDocument` generates the stored name and
 *    GridFS generates the id, so a caller cannot point one resident's row at
 *    another resident's document the way a forged object key once could;
 *  - the bytes are only ever served by an authenticated, role-checked route -
 *    there is no URL that works without a session, and none that outlives one;
 *  - the audit trail records THAT a document changed, never which file: the
 *    payloads below carry [stored]/[none], never a file id.
 */
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { DocumentKind, ResidentDto } from '@hostel/shared';
import type { AuthContext } from '../auth/context';
import { prisma, runInTransaction } from '../db/prisma';
import { NotFoundError, ValidationError, residentNotFound } from '../errors/app-error';
import {
  deleteDocument,
  maxBytesFor,
  readDocument,
  uploadDocument,
  type DocumentPayload,
} from '../storage/gridfs';
import { recordAudit } from './audit.service';
import { residentInclude, toResidentDto } from './mappers';
import { getFeeContext } from './settings.service';

/* ------------------------------------------------------------------ *
 * Kind -> field plumbing
 * ------------------------------------------------------------------ */

const DOCUMENT_KINDS = ['photo', 'aadhaar'] as const;

/** Each kind is its own field on Resident, so keep the mapping in one place. */
const DOCUMENT_LABEL: Record<DocumentKind, string> = {
  photo: 'Photo',
  aadhaar: 'Aadhaar document',
};

interface ResidentDocumentFiles {
  id: string;
  name: string;
  photoFileId: string | null;
  aadhaarFileId: string | null;
}

const storedFileId = (resident: ResidentDocumentFiles, kind: DocumentKind): string | null =>
  kind === 'photo' ? resident.photoFileId : resident.aadhaarFileId;

/**
 * A literal update payload per kind rather than a computed property, so the
 * field name stays type-checked against the Prisma model.
 */
const documentUpdate = (kind: DocumentKind, value: string | null): Prisma.ResidentUpdateInput =>
  kind === 'photo' ? { photoFileId: value } : { aadhaarFileId: value };

/**
 * Audit payload. Only presence is recorded: a GridFS file id points at an
 * identity document and has no business sitting in a log that support staff and
 * every owner can read. `recordAudit`'s own redaction list still names the old
 * S3 key fields, so this function - not that list - is what keeps ids out.
 */
const documentAudit = (kind: DocumentKind, fileId: string | null): Record<string, string> =>
  kind === 'photo'
    ? { photo: fileId ? '[stored]' : '[none]' }
    : { aadhaar: fileId ? '[stored]' : '[none]' };

const documentNotFound = (kind: DocumentKind): NotFoundError =>
  new NotFoundError(DOCUMENT_LABEL[kind], 'DOCUMENT_NOT_FOUND');

export const documentKindSchema = z.enum(DOCUMENT_KINDS);

/** Validate the `[kind]` path segment. Anything else is a 400, never a 500. */
export function parseDocumentKind(params: Record<string, unknown>, key = 'kind'): DocumentKind {
  const result = documentKindSchema.safeParse(params?.[key]);
  if (!result.success) {
    throw new ValidationError('That document type is not valid', {
      [key]: ['Must be either photo or aadhaar'],
    });
  }
  return result.data;
}

/**
 * The largest body the upload route may accept.
 *
 * One route serves both kinds and the kind is a path segment, so the route-level
 * cap has to cover the more generous of the two; `validateUpload` then enforces
 * the exact per-kind limit and turns a violation into a field-level 400 rather
 * than a bare 413. Without this the default 1 MB cap would reject every real
 * photograph.
 */
export const maxDocumentBytes = (): number =>
  Math.max(...DOCUMENT_KINDS.map((kind) => maxBytesFor(kind)));

async function loadResidentDocuments(residentId: string): Promise<ResidentDocumentFiles> {
  const resident = await prisma.resident.findUnique({
    where: { id: residentId },
    select: { id: true, name: true, photoFileId: true, aadhaarFileId: true },
  });
  if (!resident) throw residentNotFound();
  return resident;
}

/* ------------------------------------------------------------------ *
 * Upload
 * ------------------------------------------------------------------ */

export interface UploadedFile {
  buffer: Buffer;
  contentType: string;
  fileName: string;
}

/**
 * Store a new document against a resident and return the updated resident, so
 * the profile screen can flip `hasPhoto` / `hasAadhaarDocument` without a
 * follow-up fetch.
 *
 * The resident is verified before a byte is written: an upload against an
 * unknown id could never be attached to anything and would only orphan chunks
 * in the bucket. `uploadDocument` re-runs `validateUpload` against the real
 * buffer length, so a lying Content-Length cannot smuggle an oversized file past
 * the route's check.
 */
export async function uploadResidentDocument(
  residentId: string,
  kind: DocumentKind,
  file: UploadedFile,
  auth: AuthContext,
): Promise<ResidentDto> {
  const resident = await loadResidentDocuments(residentId);
  const previousFileId = storedFileId(resident, kind);

  const stored = await uploadDocument(resident.id, kind, file);

  const updated = await runInTransaction(async (tx) => {
    const row = await tx.resident.update({
      where: { id: resident.id },
      data: documentUpdate(kind, stored.fileId),
      include: residentInclude,
    });
    await recordAudit(tx, {
      auth,
      action: 'UPDATE',
      entityType: 'RESIDENT',
      entityId: resident.id,
      summary: `${DOCUMENT_LABEL[kind]} ${previousFileId ? 'replaced' : 'uploaded'} for ${resident.name}`,
      oldData: documentAudit(kind, previousFileId),
      newData: documentAudit(kind, stored.fileId),
    });
    return row;
  });

  /*
   * Ordering matters, and it is the whole reason these are three steps:
   *
   *   1. write the new file to GridFS,
   *   2. commit the pointer and the audit row together,
   *   3. only then destroy the superseded file.
   *
   * Deleting first - or deleting inside the transaction - means a rollback
   * leaves the resident pointing at bytes that no longer exist: the only copy of
   * their identity document, gone. Doing it last can at worst leave one orphaned
   * file in GridFS when the delete fails, which is housekeeping; `deleteDocument`
   * swallows and logs its own failures for exactly that reason.
   *
   * The same logic explains why a failed transaction does NOT clean up the file
   * written in step 1. A rejected `$transaction` promise does not prove the
   * transaction rolled back - a client-side timeout on a commit that actually
   * succeeded looks identical - so deleting on that path could destroy a file
   * the resident row now references. One orphan is by far the cheaper mistake.
   */
  if (previousFileId && previousFileId !== stored.fileId) {
    await deleteDocument(previousFileId);
  }

  // `vacated` is derived from the current month; the fee context supplies the
  // authoritative one rather than this service inventing a "today".
  const { context } = await getFeeContext();
  return toResidentDto(updated, { currentMonth: context.currentMonth });
}

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

/**
 * The bytes of one stored document, for the route to stream back.
 *
 * Two distinct misses collapse into the same 404: the resident has no document
 * of this kind, or the row points at a file that is no longer in GridFS
 * (`readDocument` raises DOCUMENT_NOT_FOUND for that). Neither the file id nor
 * the content is ever logged.
 */
export async function getResidentDocument(
  residentId: string,
  kind: DocumentKind,
): Promise<DocumentPayload> {
  const resident = await loadResidentDocuments(residentId);
  const fileId = storedFileId(resident, kind);
  if (!fileId) throw documentNotFound(kind);
  return readDocument(fileId);
}

/* ------------------------------------------------------------------ *
 * Delete
 * ------------------------------------------------------------------ */

/**
 * Remove a document. The resident is never deleted - only the pointer is
 * cleared, in a transaction with its audit row, and the file is dropped
 * afterwards for the same ordering reason as the upload.
 */
export async function removeResidentDocument(
  residentId: string,
  kind: DocumentKind,
  auth: AuthContext,
): Promise<void> {
  const resident = await loadResidentDocuments(residentId);
  const fileId = storedFileId(resident, kind);
  if (!fileId) throw documentNotFound(kind);

  await runInTransaction(async (tx) => {
    await tx.resident.update({
      where: { id: resident.id },
      data: documentUpdate(kind, null),
    });
    await recordAudit(tx, {
      auth,
      action: 'UPDATE',
      entityType: 'RESIDENT',
      entityId: resident.id,
      summary: `${DOCUMENT_LABEL[kind]} removed for ${resident.name}`,
      oldData: documentAudit(kind, fileId),
      newData: documentAudit(kind, null),
    });
  });

  // Committed first, deleted second: had the transaction rolled back after the
  // file was destroyed, the row would still advertise a document whose bytes are
  // gone. An orphan is recoverable; a dangling pointer is not.
  await deleteDocument(fileId);
}
