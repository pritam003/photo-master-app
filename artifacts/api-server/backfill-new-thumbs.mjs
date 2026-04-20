/**
 * Generate thumbnails + LQIP for photos that have NO thumb_blob_name yet.
 * Run after a bulk import that pre-dates inline thumbnail generation.
 *
 * Usage:
 *   AZURE_STORAGE_ACCOUNT_NAME=... AZURE_STORAGE_CONTAINER_NAME=... DATABASE_URL=... node backfill-new-thumbs.mjs
 *
 * Runs 10 concurrent workers; safe to re-run (skips photos that already have thumbs).
 */

import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import sharp from "sharp";
import pg from "pg";
import path from "path";

const { Client } = pg;

const THUMB_SIZE = 600;
const PREVIEW_WIDTH = 1920;
const LQIP_SIZE = 20;
const CONCURRENCY = 10;

const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
const dbUrl = process.env.DATABASE_URL;

if (!accountName || !containerName || !dbUrl) {
  console.error("Missing env: AZURE_STORAGE_ACCOUNT_NAME, AZURE_STORAGE_CONTAINER_NAME, DATABASE_URL");
  process.exit(1);
}

const credential = new DefaultAzureCredential();
const blobServiceClient = new BlobServiceClient(
  `https://${accountName}.blob.core.windows.net`,
  credential,
);
const containerClient = blobServiceClient.getContainerClient(containerName);

async function downloadBlob(blobName) {
  const blobClient = containerClient.getBlobClient(blobName);
  const download = await blobClient.download();
  const chunks = [];
  for await (const chunk of download.readableStreamBody) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function uploadBlob(blobName, data, contentType) {
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.upload(data, data.length, {
    blobHTTPHeaders: {
      blobContentType: contentType,
      blobCacheControl: "public, max-age=31536000, immutable",
    },
    overwrite: true,
  });
}

async function processPhoto(row, db) {
  const { id, blob_name, content_type } = row;

  const dir = path.dirname(blob_name);
  const base = path.basename(blob_name, path.extname(blob_name));
  const thumbBlobName = `${dir}/thumb_${base}.jpg`;
  const previewBlobName = `${dir}/preview_${base}.jpg`;

  try {
    const imageBuffer = await downloadBlob(blob_name);

    const sharpInstance = sharp(imageBuffer, { failOn: "none" }).rotate();

    const [thumbBuf, previewBuf, lqipBuf] = await Promise.all([
      sharpInstance.clone()
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: "cover", position: "centre" })
        .jpeg({ quality: 82, mozjpeg: true, progressive: true })
        .toBuffer(),
      sharpInstance.clone()
        .resize(PREVIEW_WIDTH, undefined, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 88, mozjpeg: true, progressive: true })
        .toBuffer(),
      sharpInstance.clone()
        .resize(LQIP_SIZE, LQIP_SIZE, { fit: "cover", position: "centre" })
        .blur(3)
        .jpeg({ quality: 20 })
        .toBuffer(),
    ]);

    await Promise.all([
      uploadBlob(thumbBlobName, thumbBuf, "image/jpeg"),
      uploadBlob(previewBlobName, previewBuf, "image/jpeg"),
    ]);

    const lqipData = `data:image/jpeg;base64,${lqipBuf.toString("base64")}`;

    await db.query(
      `UPDATE photos SET thumb_blob_name = $1, preview_blob_name = $2, lqip_data = $3 WHERE id = $4`,
      [thumbBlobName, previewBlobName, lqipData, id],
    );

    return true;
  } catch (err) {
    console.error(`  ✗ ${blob_name}: ${err.message}`);
    return false;
  }
}

async function main() {
  const db = new Client({ connectionString: dbUrl });
  await db.connect();

  const { rows } = await db.query(`
    SELECT id, blob_name, content_type
    FROM photos
    WHERE thumb_blob_name IS NULL
      AND content_type NOT LIKE 'video/%'
      AND trashed = false
    ORDER BY uploaded_at DESC
  `);

  console.log(`Found ${rows.length} photos without thumbnails — processing with ${CONCURRENCY} workers...\n`);

  if (rows.length === 0) {
    console.log("Nothing to do.");
    await db.end();
    return;
  }

  let ok = 0, fail = 0;
  let idx = 0;
  const total = rows.length;

  async function worker() {
    while (idx < rows.length) {
      const row = rows[idx++];
      const n = ok + fail + 1;
      const success = await processPhoto(row, db);
      if (success) {
        ok++;
        if (ok % 25 === 0 || ok === total) {
          console.log(`[${ok + fail}/${total}] ✓ ${Math.round(((ok + fail) / total) * 100)}% done`);
        }
      } else {
        fail++;
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker());
  await Promise.all(workers);

  await db.end();
  console.log(`\nDone: ${ok} thumbnails generated, ${fail} failed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
