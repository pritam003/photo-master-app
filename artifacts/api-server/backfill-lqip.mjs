#!/usr/bin/env node
/**
 * One-shot backfill: generate 20×20 LQIP (Low Quality Image Placeholder) from existing thumbnails.
 * Updates photos.lqip_data with a base64 data URL for the blurred micro-thumbnail.
 *
 * Run from the api-server directory:
 *   AZURE_STORAGE_ACCOUNT_NAME=... AZURE_STORAGE_CONTAINER_NAME=... DATABASE_URL=... node backfill-lqip.mjs
 */
import sharp from "sharp";
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import pg from "pg";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("DATABASE_URL env var required");

const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
if (!accountName || !containerName)
  throw new Error("AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_CONTAINER_NAME required");

const credential = new DefaultAzureCredential();
const blobServiceClient = new BlobServiceClient(
  `https://${accountName}.blob.core.windows.net`,
  credential
);
const containerClient = blobServiceClient.getContainerClient(containerName);

async function downloadBlob(blobName) {
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  const downloadResponse = await blockBlobClient.download(0);
  const chunks = [];
  for await (const chunk of downloadResponse.readableStreamBody) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const { Client } = pg;
const client = new Client({ connectionString: DB_URL });
await client.connect();

const res = await client.query(`
  SELECT id, filename, thumb_blob_name
  FROM public.photos
  WHERE lqip_data IS NULL
    AND thumb_blob_name IS NOT NULL
    AND content_type NOT LIKE 'video/%'
  ORDER BY uploaded_at DESC
`);

console.log(`Found ${res.rows.length} photos needing LQIP generation`);

let done = 0, errors = 0;
for (const photo of res.rows) {
  try {
    const buf = await downloadBlob(photo.thumb_blob_name);
    const lqipBuf = await sharp(buf)
      .resize(20, 20, { fit: "cover" })
      .blur(3)
      .jpeg({ quality: 20 })
      .toBuffer();
    const lqipData = `data:image/jpeg;base64,${lqipBuf.toString("base64")}`;
    await client.query("UPDATE public.photos SET lqip_data = $1 WHERE id = $2", [lqipData, photo.id]);
    done++;
    if (done % 50 === 0 || done === res.rows.length) {
      console.log(`[${done}/${res.rows.length}] ${photo.filename} ✓`);
    }
  } catch (e) {
    console.error(`✗ ${photo.filename} → ${e.message}`);
    errors++;
  }
}

console.log(`\nDone: ${done} LQIP generated, ${errors} errors`);
await client.end();
