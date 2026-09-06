/**
 * Resident photographs and Aadhaar documents, stored in MongoDB GridFS.
 *
 * These are identity documents, so the rules are strict:
 *   - they are never public, and never have a permanent URL
 *   - every read goes through an authenticated, authorised API route that
 *     streams the bytes; the browser only ever sees `/api/residents/:id/
 *     documents/:kind`, which 401s without a session
 *   - neither the contents nor the file id is ever written to a log or an audit
 *     payload
 *
 * GridFS rather than a plain document field because MongoDB caps a single
 * document at 16 MB; GridFS chunks the file across a `documents.chunks`
 * collection and keeps metadata in `documents.files`, so a large scan or PDF is
 * fine and the bytes are streamed rather than loaded whole.
 *
 * Prisma has no GridFS support, so this module uses the native driver directly.
 * It keeps its own small connection pool, cached across warm Lambda invocations
 * exactly like the Prisma client.
 */
import { GridFSBucket, MongoClient, ObjectId, type GridFSFile } from 'mongodb';
import type { DocumentKind } from '@hostel/shared';
import { env, maxUploadBytes } from '../env';
import { AppError, NotFoundError, ValidationError } from '../errors/app-error';
import { logger } from '../http/logger';

const BUCKET_NAME = 'documents';

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const DOCUMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

/** Photos are displayed in a small square; they never need to be huge. */
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

const globalForMongo = globalThis as unknown as {
  hostelMongoClient?: MongoClient;
  hostelMongoConnect?: Promise<MongoClient>;
};

async function client(): Promise<MongoClient> {
  if (globalForMongo.hostelMongoClient) return globalForMongo.hostelMongoClient;
  // Cache the in-flight promise too, so two concurrent uploads on a cold start
  // do not each open a pool.
  if (!globalForMongo.hostelMongoConnect) {
    globalForMongo.hostelMongoConnect = new MongoClient(env().DATABASE_URL, {
      maxPoolSize: 3,
      serverSelectionTimeoutMS: 10_000,
    })
      .connect()
      .then((connected) => {
        globalForMongo.hostelMongoClient = connected;
        return connected;
      })
      .catch((error) => {
        // Let the next attempt retry rather than caching a rejected promise.
        globalForMongo.hostelMongoConnect = undefined;
        throw error;
      });
  }
  return globalForMongo.hostelMongoConnect;
}

async function bucket(): Promise<GridFSBucket> {
  const connection = await client();
  // The database name comes from the connection string, as it does for Prisma.
  return new GridFSBucket(connection.db(), { bucketName: BUCKET_NAME });
}

export function allowedTypesFor(kind: DocumentKind): readonly string[] {
  return kind === 'photo' ? PHOTO_TYPES : DOCUMENT_TYPES;
}

export function maxBytesFor(kind: DocumentKind): number {
  return kind === 'photo' ? MAX_PHOTO_BYTES : maxUploadBytes();
}

/** Reject anything we are not willing to store, before a byte is written. */
export function validateUpload(kind: DocumentKind, contentType: string, size: number): void {
  const allowed = allowedTypesFor(kind);
  if (!allowed.includes(contentType)) {
    throw new ValidationError('That file type is not accepted', {
      file: [`Allowed file types: ${allowed.join(', ')}`],
    });
  }
  const max = maxBytesFor(kind);
  if (size <= 0) {
    throw new ValidationError('That file appears to be empty', { file: ['The file has no content'] });
  }
  if (size > max) {
    throw new ValidationError('That file is too large', {
      file: [`File must be ${Math.round(max / (1024 * 1024))} MB or smaller`],
    });
  }
}

export function toObjectId(id: string): ObjectId {
  try {
    return new ObjectId(id);
  } catch {
    throw new ValidationError('That document reference is not valid');
  }
}

export interface StoredDocument {
  fileId: string;
  contentType: string;
  size: number;
}

/**
 * Store a file and return its id. The caller saves that id on the resident,
 * inside a transaction, and only then deletes any previous file.
 */
export async function uploadDocument(
  residentId: string,
  kind: DocumentKind,
  file: { buffer: Buffer; contentType: string; fileName: string },
): Promise<StoredDocument> {
  validateUpload(kind, file.contentType, file.buffer.byteLength);

  const gridfs = await bucket();
  // The stored name is server-generated: a client-supplied filename is never
  // trusted into a path or a Content-Disposition header.
  const safeName = `${residentId}-${kind}-${Date.now()}`;

  return new Promise<StoredDocument>((resolve, reject) => {
    const stream = gridfs.openUploadStream(safeName, {
      // The driver's typings no longer expose a top-level contentType, so it
      // travels in metadata and is read back from there.
      metadata: {
        residentId,
        kind,
        contentType: file.contentType,
        uploadedAt: new Date(),
        // Kept only for support questions; never rendered to another user.
        originalExtension: file.fileName.split('.').pop()?.slice(0, 8) ?? null,
      },
    });

    stream.on('error', (error) =>
      reject(
        new AppError(500, 'UPLOAD_FAILED', 'That file could not be saved. Please try again.', {
          cause: error,
        }),
      ),
    );
    stream.on('finish', () =>
      resolve({
        fileId: stream.id.toString(),
        contentType: file.contentType,
        size: file.buffer.byteLength,
      }),
    );

    stream.end(file.buffer);
  });
}

export interface DocumentPayload {
  body: Buffer;
  contentType: string;
  size: number;
}

/**
 * Read a stored document.
 *
 * Buffered rather than piped because API Gateway has to materialise the whole
 * response anyway, and these files are capped at a few megabytes.
 */
export async function readDocument(fileId: string): Promise<DocumentPayload> {
  const gridfs = await bucket();
  const objectId = toObjectId(fileId);

  const files = (await gridfs.find({ _id: objectId }).limit(1).toArray()) as GridFSFile[];
  const file = files[0];
  if (!file) throw new NotFoundError('Document', 'DOCUMENT_NOT_FOUND');

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = gridfs.openDownloadStream(objectId);
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });

  const metadata = (file.metadata ?? {}) as { contentType?: string };
  return {
    body: Buffer.concat(chunks),
    contentType: metadata.contentType ?? 'application/octet-stream',
    size: file.length,
  };
}

/**
 * Delete a stored document.
 *
 * A failure is logged rather than thrown: an orphaned GridFS file is a
 * housekeeping problem, whereas failing the request would leave the database
 * pointing at a document the user believes they removed.
 */
export async function deleteDocument(fileId: string | null | undefined): Promise<void> {
  if (!fileId) return;
  try {
    const gridfs = await bucket();
    await gridfs.delete(toObjectId(fileId));
  } catch (error) {
    // Already gone is success as far as the caller is concerned.
    logger.warn('Could not delete stored document', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
}

/** Does the file still exist? Used by the profile endpoint before offering it. */
export async function documentExists(fileId: string | null | undefined): Promise<boolean> {
  if (!fileId) return false;
  try {
    const gridfs = await bucket();
    const found = await gridfs.find({ _id: toObjectId(fileId) }).limit(1).toArray();
    return found.length > 0;
  } catch {
    return false;
  }
}

/** Storage is always available - it is the same cluster as the rest of the data. */
export const isStorageConfigured = (): boolean => true;
