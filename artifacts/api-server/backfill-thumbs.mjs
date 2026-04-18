#!/usr/bin/env node
/**
 * Backfill: re-generate all existing thumbnails at 300×300 px quality 70.
 * Existing thumbs are 600×600 q82 (~100-150KB). New ones will be ~15-25KB.
 * Downloads each existing thumb, resizes, re-uploads to the same blob path.
 *
 * Usage:
 *   AZURE_STORAGE_ACCOUNT_NAME=... AZURE_STORAGE_CONTAINER_NAME=photos \
 *   DATABASE_URL=... node backfill-thumbs.mjs
 */
import sharp from "sharp";
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import pg from "pg";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("DATABASE_URL env var required");
const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
if (!accountName || !containerName) throw new Error("AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_CONTAINER_NAME required");

const BATCH = 10;
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
  SELECT id, thumb_blob_name
  FROM public.photos
  WHERE thumb_blob_name IS NOT NULL
    AND thumb_blob_name != ''
    AND content_type LIKE 'image/%'
  ORDER BY uploaded_at DESC
`);

console.log(`Found ${rows.length} thumbnails to re-generate at ${NEW_SIZE}×${NEW_SIZE} q${NEW_QUALITY}`);

let ok = 0, skipped = 0, errors = 0;

for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  await Promise.all(batch.map(async (row) => {
    try {
      const original = await downloadBlob(row.thumb_blob_name);
      // Check current size — skip if already small (re-run safe)
      const meta = await sharp(original).metadata();
      if (meta.width && meta.width <= NEW_SIZE + 20) {
        skipped++;
        return;
      }
      const resized = await sharp(original, { failOn: "none" })
        .resize(NEW_SIZE, NEW_SIZE, { fit: "cover", position: "centre" })
        .jpeg({ quality: NEW_QUALITY, mozjpeg: true })
        .toBuffer();
      await uploadBlob(row.thumb_blob_name, resized);
      const reduction = (((original.length - resized.length) / original.length) * 100).toFixed(0);
      console.log(`✓ [${i + batch.indexOf(row) + 1}/${rows.length}] ${row.thumb_blob_name.split("/").pop()} ${(original.length/1024).toFixed(0)}KB → ${(resized.length/1024).toFixed(0)}KB (-${reduction}%)`);
      ok++;
    } catch (e) {
      console.error(`✗ ${row.thumb_blob_name}: ${e.message}`);
      errors++;
    }
  }));
}

console.log(`\nDone: ${ok} re-generated, ${skipped} already small, ${errors} errors`);
await db.end();
