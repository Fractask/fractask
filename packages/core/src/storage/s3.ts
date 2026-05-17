import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageAdapter } from './index.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name} (GETSHIT_STORAGE=s3 requires it)`);
  return v;
}

export function createS3Adapter(): StorageAdapter {
  const bucket = requireEnv('GETSHIT_S3_BUCKET');
  const region = process.env['GETSHIT_S3_REGION'] ?? 'auto';
  const endpoint = process.env['GETSHIT_S3_ENDPOINT'];
  const accessKeyId = requireEnv('GETSHIT_S3_ACCESS_KEY_ID');
  const secretAccessKey = requireEnv('GETSHIT_S3_SECRET_ACCESS_KEY');

  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    kind: 's3',
    async put(key, body, mimeType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: mimeType,
        }),
      );
    },
    async getStream(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = res.Body;
      if (!body || typeof (body as { transformToWebStream?: () => unknown }).transformToWebStream !== 'function') {
        throw new Error('S3 response missing stream');
      }
      const stream = (body as { transformToWebStream: () => ReadableStream<Uint8Array> })
        .transformToWebStream();
      return { body: stream, ...(res.ContentType ? { mimeType: res.ContentType } : {}) };
    },
    async getSignedUrl(key, ttlSeconds = 300) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: ttlSeconds },
      );
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
