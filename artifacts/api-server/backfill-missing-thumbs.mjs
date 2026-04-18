#!/usr/bin/env node
/**
 * Backfill: generate thumbnails for photos that have NONE (thumb_blob_name IS NULL).
 * Downloads the full-size blob, resizes to 300×300 q70, uploads as thumb_, updates DB.
 *
 * Usage:
 *   AZURE_STORAGE_ACCOUNT_NAME=... AZURE_STORAGE_CONTAINER_NAME=photos \
 *   DATABASE_URL=... node backfill-missing-thumbs.mjs
 */
import sharp from "sharp";
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import pg from "pg";
import path from "path";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("DATABASE_URL env var required");
const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
if (!accountName || !containerName) throw new Error("AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_CONTAINER_NAME required");

const BATCH = 5;
const NEW_SIZE = 300;
const NEW_QUALITY = 70;

const credential = new DefaultAzureCredential();
const blobServiceClient = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential);
const containerClient = blobServiceClient.getContainerClient(containerName);

async function downloadBlob(blobName) {
  const client = containerClient.getBlockBlobClient(blobName);
  const resp = await client.download(0);
  const chunks = [];
  for await (const chunk of resp.readableStreamBody) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function uploadBlob(blobName, buf) {
  const client = containerClient.getBlockBlobClient(blobName);
  await client.uploadData(buf, { blobHTTPHeaders: { blobContentType: "image/jpeg" } });
}

const { Client } = pg;
const db = new Client({ connectionString: DB_URL });
await db.connect();

const { rows } = await db.query(`
  SELECT id, blob_name, content_type
  FROM public.photos
  WHERE thumb_blob_name IS NULL
    AND trashed = false
    AND content_type LIKE 'image/%'
  ORDER BY uploaded_at DESC
`);

console.log(`Found ${rows.length} photos with no thumbnail — generating at ${NEW_SIZE}×${NEW_SIZE} q${NEW_QUALITY}`);

let ok = 0, errors = 0;

for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  await Promise.all(batch.map(async (row) => {
    try {
      const original = await downloadBlob(row.blob_name);

      const resized = await sharp(original, { failOn: "none" })
        .resize(NEW_SIZE, NEW_SIZE, { fit: "cover", position: "centre" })
        .jpeg({ quality: NEW_QUALITY, mozjpeg: true })
        .toBuffer();

      // Derive thumb blob name from the original: dir/thumb_uuid.jpg
      const dir = path.dirname(row.blob_name);
      const base = path.basename(row.blob_name, path.extname(row.blob_name));
      const thumbBlobName = `${dir}/thumb_${base}.jpg`;

      await uploadBlob(thumbBlobName, resized);

      // Update DB
      await db.query(
        `UPDATE public.photos SET thumb_blob_name = $1 WHERE id = $2`,
        [thumbBlobName, row.id]
      );

      const reduction = (((original.length - resized.length) / original.length) * 100).toFixed(0);
      console.log(`✓ [${i + batch.indexOf(row) + 1}/${rows.length}] ${path.basename(row.blob_name)} ${(original.length/1024).toFixed(0)}KB → ${(resized.length/1024).toFixed(0)}KB (-${reduction}%)`);
      ok++;
    } catch (e) {
      console.error(`✗ ${row.blob_name}: ${e.message}`);
      errors++;
    }
  }));
}

console.log(`\nDone: ${ok} thumbnails generated, ${errors} errors`);
await db.end();
