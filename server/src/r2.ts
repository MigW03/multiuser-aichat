import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env.ts";

// Cloudflare R2 through its S3-compatible API. The only code that talks to the bucket; everything else gets an ObjectStore,
// so tests can use an in-memory one. Keys are built by file-paths.ts, never from raw request input. The credentials come
// from the environment (env.ts) and never appear in a message, a log line or an answer.

export type R2Config = { accessKeyId: string; secretAccessKey: string; endpoint: string; bucket: string };

export type StoredObject = { key: string; bytes: number; modified: string | null };
export type Listing = { files: StoredObject[]; dirs: string[]; truncated: boolean };
export type Usage = { bytes: number; files: number };

export interface ObjectStore {
  /** Writes one object. It is always stored (and later served) as a download, never as a page. */
  put(key: string, body: Uint8Array, meta?: Record<string, string>): Promise<void>;
  head(key: string): Promise<StoredObject | null>;
  /** One object's bytes, or null when there is none. For small objects only (designs): the whole body is held in memory. */
  get(key: string, maxBytes: number): Promise<Uint8Array | null>;
  /** The files and sub-folders directly under `prefix` (which ends in "/"). */
  list(prefix: string, max: number): Promise<Listing>;
  /** Everything under `prefix`, counted. `null` when there are more than `maxFiles`. */
  usage(prefix: string, maxFiles: number): Promise<Usage | null>;
  remove(key: string): Promise<void>;
  /** Every object under `prefix` (which ends in "/"). Returns how many were removed. */
  removePrefix(prefix: string): Promise<number>;
  /** An address that downloads one object for `seconds`, with the file name `filename`. */
  downloadUrl(key: string, filename: string, seconds: number): Promise<string>;
}

export class StorageOffError extends Error {
  constructor(readonly missing: string[]) {
    super(`File storage is not set up. Missing: ${missing.join(", ")}`);
  }
}

/** The names of the R2 variables that are not set (never their values). */
export function missingR2(): string[] {
  const { accessKeyId, secretAccessKey, endpoint, bucket } = env.r2;
  return Object.entries({ R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_ENDPOINT: endpoint, R2_BUCKET: bucket }).filter(([, v]) => !v).map(([k]) => k);
}

/** The configuration from the environment, or an error naming the variables that are not set (never their values). */
export function r2ConfigFromEnv(): R2Config {
  const { accessKeyId, secretAccessKey, endpoint, bucket } = env.r2;
  const missing = missingR2();
  if (missing.length > 0 || !accessKeyId || !secretAccessKey || !endpoint || !bucket) throw new StorageOffError(missing);
  return { accessKeyId, secretAccessKey, endpoint, bucket };
}

export const storageOn = () => Boolean(env.r2.accessKeyId && env.r2.secretAccessKey && env.r2.endpoint && env.r2.bucket);

const PAGE = 1000;

export function createR2Store(config: R2Config): ObjectStore {
  const client = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true,
    // R2 does not accept the extra checksum headers newer SDK versions add by default.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3,
  });
  const Bucket = config.bucket;
  const iso = (d: Date | undefined) => (d ? d.toISOString() : null);

  return {
    async put(key, body, meta) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentLength: body.byteLength, ContentType: "application/octet-stream", ContentDisposition: "attachment", Metadata: meta }));
    },

    async head(key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { key, bytes: r.ContentLength ?? 0, modified: iso(r.LastModified) };
      } catch (e) {
        if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },

    async get(key, maxBytes) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if ((r.ContentLength ?? 0) > maxBytes) throw new Error("object larger than allowed");
        const body = await r.Body?.transformToByteArray();
        if (!body) return null;
        if (body.byteLength > maxBytes) throw new Error("object larger than allowed");
        return body;
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404 || (e as { name?: string }).name === "NoSuchKey") return null;
        throw e;
      }
    },

    async list(prefix, max) {
      const files: StoredObject[] = [];
      const dirs: string[] = [];
      let token: string | undefined;
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, Delimiter: "/", MaxKeys: Math.min(PAGE, max + 1), ContinuationToken: token }));
        for (const o of r.Contents ?? []) if (o.Key && o.Key !== prefix) files.push({ key: o.Key, bytes: o.Size ?? 0, modified: iso(o.LastModified) });
        for (const p of r.CommonPrefixes ?? []) if (p.Prefix) dirs.push(p.Prefix);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token && files.length + dirs.length <= max);
      return { files, dirs, truncated: files.length + dirs.length > max || Boolean(token) };
    },

    async usage(prefix, maxFiles) {
      let bytes = 0;
      let files = 0;
      let token: string | undefined;
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, MaxKeys: PAGE, ContinuationToken: token }));
        for (const o of r.Contents ?? []) {
          files += 1;
          bytes += o.Size ?? 0;
        }
        if (files > maxFiles) return null;
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return { bytes, files };
    },

    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    async removePrefix(prefix) {
      if (!prefix.endsWith("/")) throw new Error("removePrefix needs a prefix that ends in /");
      let removed = 0;
      for (;;) {
        // Always the first page: what was just deleted is gone from the next listing.
        const r = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, MaxKeys: PAGE }));
        const keys = (r.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (keys.length === 0) return removed;
        const out = await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys, Quiet: true } }));
        if (out.Errors?.length) throw new Error(`could not remove ${out.Errors.length} objects`);
        removed += keys.length;
      }
    },

    async downloadUrl(key, filename, seconds) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket,
          Key: key,
          // Whatever the file is, the browser saves it and does not run it.
          ResponseContentType: "application/octet-stream",
          ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        }),
        { expiresIn: seconds },
      );
    },
  };
}

let shared: ObjectStore | null = null;

/** The one store for this process. Throws StorageOffError when the R2_ variables are not set. */
export function objectStore(): ObjectStore {
  shared ??= createR2Store(r2ConfigFromEnv());
  return shared;
}
