/**
 * Cloudflare R2 wrapper (S3-compatible) using the AWS SDK v3 S3 client.
 *
 * Env: R2_ENDPOINT (e.g. https://<accountId>.r2.cloudflarestorage.com),
 *      R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
 *      R2_PUBLIC_BASE_URL (public bucket URL, e.g. https://pub-<id>.r2.dev
 *      or a custom domain — used for playback so bytes come from R2).
 */
'use strict';

const fs = require('fs');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

function createR2Client({ endpoint, accessKeyId, secretAccessKey, bucket, publicBaseUrl }) {
  const s3 = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  function publicUrl(key) {
    if (!publicBaseUrl) return null;
    return `${publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }

  async function putFile(key, filePath, contentType) {
    const stat = fs.statSync(filePath);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: contentType || 'application/octet-stream',
      ContentLength: stat.size,
    }));
  }

  async function getStream(key, range) {
    const cmd = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(range ? { Range: range } : {}),
    });
    const res = await s3.send(cmd);
    return {
      stream: res.Body, // Node Readable
      contentLength: res.ContentLength,
      contentRange: res.ContentRange,
      contentType: res.ContentType,
      statusCode: res.$metadata.httpStatusCode,
    };
  }

  async function deleteFile(key) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  return { putFile, getStream, deleteFile, publicUrl, bucket };
}

module.exports = { createR2Client };
