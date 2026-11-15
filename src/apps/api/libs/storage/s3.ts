// Wrapper fino sobre AWS SDK v3 para object storage S3-compatível (RustFS em
// dev, AWS S3 / Cloudflare R2 em prod). `forcePathStyle` configurável
// (RustFS/MinIO precisam); erros propagam (caller decide retry/fallback).

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3@3.879.0";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3.879.0";
import { env } from "$config/env.ts";

let cached: S3Client | null = null;

function client(): S3Client {
  if (cached) return cached;
  cached = new S3Client({
    endpoint: env.s3.endpoint,
    region: env.s3.region,
    credentials: {
      accessKeyId: env.s3.accessKey,
      secretAccessKey: env.s3.secretKey,
    },
    forcePathStyle: env.s3.forcePathStyle,
  });
  return cached;
}

// Cria o bucket se não existir (idempotente). Em prod já existe; em dev
// (RustFS volume novo) precisa de ser criado.
export async function ensureBucket(): Promise<void> {
  const c = client();
  try {
    await c.send(new HeadBucketCommand({ Bucket: env.s3.bucket }));
    return; // existe
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    // 404 ou NoSuchBucket → criar
    if (
      err.$metadata?.httpStatusCode === 404 || err.name === "NotFound" ||
      err.name === "NoSuchBucket"
    ) {
      await c.send(new CreateBucketCommand({ Bucket: env.s3.bucket }));
      return;
    }
    throw e;
  }
}

export interface PutResult {
  key: string;
  etag: string | null;
  size: number;
  sha256: string;
}

// Upload para o bucket. Devolve ETag (integridade S3-side) + SHA-256 local
// (audit independente) para gravar na linha do recibo.
export async function putObject(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<PutResult> {
  const sha256Bytes = await crypto.subtle.digest("SHA-256", body as unknown as BufferSource);
  const sha256 = Array.from(new Uint8Array(sha256Bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const res = await client().send(
    new PutObjectCommand({
      Bucket: env.s3.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.byteLength,
    }),
  );

  return {
    key,
    etag: res.ETag ?? null,
    size: body.byteLength,
    sha256,
  };
}

export async function getObject(key: string): Promise<Uint8Array> {
  const res = await client().send(
    new GetObjectCommand({
      Bucket: env.s3.bucket,
      Key: key,
    }),
  );
  if (!res.Body) throw new Error(`S3 GET ${key}: empty body`);
  // `transformToByteArray()` funciona cross-runtime; mais robusto que castar
  // para ReadableStream (pode ser Node Readable em alguns runtimes).
  return await (res.Body as { transformToByteArray: () => Promise<Uint8Array> })
    .transformToByteArray();
}

// Apaga objeto do S3. Idempotente: S3 DELETE devolve 200/204 mesmo para keys
// inexistentes. Usado pelo soft-delete de attachments (ADR 0021).
export async function deleteObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: env.s3.bucket, Key: key }));
}

// URL pré-assinada (default 5 min) para o browser baixar direto do S3 sem
// passar pelo backend, poupando bandwidth em ficheiros grandes.
export async function presignedDownloadUrl(
  key: string,
  ttlSeconds = 300,
): Promise<string> {
  return await getSignedUrl(
    client(),
    new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }),
    { expiresIn: ttlSeconds },
  );
}
