import { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, UserDelegationKey } from "@azure/storage-blob";
import { DefaultAzureCredential, ManagedIdentityCredential } from "@azure/identity";
import { Readable } from "stream";

const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME!;
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME!;

let blobServiceClient: BlobServiceClient;

function getBlobServiceClient(): BlobServiceClient {
  if (blobServiceClient) return blobServiceClient;

  // In production, use ManagedIdentityCredential directly (system-assigned) to avoid
  // the 30-second DefaultAzureCredential chain timeout when other credential types fail.
  const credential =
    process.env.NODE_ENV === "production"
      ? new ManagedIdentityCredential()
      : new DefaultAzureCredential();

  blobServiceClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential,
  );

  return blobServiceClient;
}

export function getContainerClient() {
  return getBlobServiceClient().getContainerClient(containerName);
}

// Cache the user delegation key using a Promise so concurrent callers share one in-flight request
let _delegationKeyPromise: Promise<UserDelegationKey> | null = null;
let _delegationKeyExpiry: Date | null = null;

async function getUserDelegationKey(): Promise<UserDelegationKey> {
  const now = new Date();
  const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);
  if (_delegationKeyPromise && _delegationKeyExpiry && _delegationKeyExpiry > tenMinutesFromNow) {
    return _delegationKeyPromise;
  }
  // Round key window to the current hour so SAS signatures stay stable across concurrent calls
  const keyStart = new Date(now);
  keyStart.setMinutes(0, 0, 0);
  const keyExpiry = new Date(keyStart.getTime() + 6 * 60 * 60 * 1000);
  _delegationKeyExpiry = keyExpiry;
  const p = getBlobServiceClient().getUserDelegationKey(keyStart, keyExpiry);
  // Don't cache rejections — a transient credential failure shouldn't poison all future calls
  _delegationKeyPromise = p.catch((err) => {
    _delegationKeyPromise = null;
    _delegationKeyExpiry = null;
    throw err;
  });
  return _delegationKeyPromise;
}

export async function uploadBlob(
  blobName: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  const containerClient = getContainerClient();
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.uploadData(data, {
    blobHTTPHeaders: {
      blobContentType: contentType,
      blobCacheControl: "public, max-age=31536000, immutable",
    },
  });
  return blobName;
}

/**
 * Stream-upload a blob directly from a Node.js Readable — no full-file buffer needed.
 * Uses 4 MB blocks with up to 4 concurrent block uploads.
 */
export async function uploadBlobFromStream(
  blobName: string,
  stream: Readable,
  contentType: string,
): Promise<void> {
  const containerClient = getContainerClient();
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.uploadStream(stream, 4 * 1024 * 1024, 4, {
    blobHTTPHeaders: {
      blobContentType: contentType,
      blobCacheControl: "public, max-age=31536000, immutable",
    },
  });
}

export async function deleteBlob(blobName: string): Promise<void> {
  const containerClient = getContainerClient();
  const blobClient = containerClient.getBlobClient(blobName);
  await blobClient.deleteIfExists();
}

export async function downloadBlob(blobName: string): Promise<Buffer> {
  const containerClient = getContainerClient();
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  const downloadResponse = await blockBlobClient.download(0);
  const chunks: Uint8Array[] = [];
  for await (const chunk of downloadResponse.readableStreamBody as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Returns a read-only SAS URL for a blob (1-hour expiry).
// Uses a module-level cached delegation key refreshed every 5.5 hours.
// In dev, returns an authenticated proxy path instead.

let _cachedReadKey: UserDelegationKey | null = null;
let _readKeyExpiry: Date | null = null;

/** Pre-warm (or refresh) the delegation key used for read SAS generation.
 *  Called at startup and periodically so generateSasUrl() stays synchronous. */
export async function warmReadSasKey(): Promise<void> {
  const now = new Date();
  if (_cachedReadKey && _readKeyExpiry && _readKeyExpiry.getTime() - now.getTime() > 30 * 60 * 1000) {
    return; // still valid for >30 min
  }
  try {
    const keyStart = new Date(now);
    keyStart.setMinutes(0, 0, 0);
    const keyExpiry = new Date(keyStart.getTime() + 6 * 60 * 60 * 1000); // 6 hours
    _cachedReadKey = await getBlobServiceClient().getUserDelegationKey(keyStart, keyExpiry);
    _readKeyExpiry = keyExpiry;
  } catch (err) {
    console.error("[azure-storage] failed to warm read SAS key:", err);
  }
}

export function generateSasUrl(blobName: string, ttlSeconds = 3600): string {
  if (process.env.NODE_ENV !== "production") {
    return `/api/blobs/${blobName}`;
  }

  // If delegation key is available, generate a proper read SAS
  if (_cachedReadKey && _readKeyExpiry && _readKeyExpiry > new Date()) {
    try {
      const now = new Date();
      const expiresOn = new Date(now.getTime() + ttlSeconds * 1000);
      const sasParams = generateBlobSASQueryParameters(
        {
          containerName,
          blobName,
          permissions: BlobSASPermissions.parse("r"),
          startsOn: now,
          expiresOn,
        },
        _cachedReadKey,
        accountName,
      );
      return `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasParams.toString()}`;
    } catch {
      // fall through to plain URL
    }
  }

  // Fallback: plain URL (works if container is public, otherwise broken — will fix on next warmup)
  return `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}`;
}

// Generate a write-only SAS URL so the browser can upload directly to Blob Storage
// without routing the file bytes through the API.
// Returns "" if the delegation key cannot be obtained — the client falls back to multipart POST.
export async function generateUploadSasUrl(blobName: string, contentType: string): Promise<string> {
  if (process.env.NODE_ENV !== "production") {
    // In dev the browser upload goes through the API proxy (handled in photos route)
    return "";
  }

  try {
    const startsOn = new Date();
    const expiresOn = new Date(startsOn.getTime() + 30 * 60 * 1000); // 30 min to complete upload
    const userDelegationKey = await getUserDelegationKey();

    const sasParams = generateBlobSASQueryParameters(
      {
        containerName,
        blobName,
        permissions: BlobSASPermissions.parse("cw"), // create + write
        startsOn,
        expiresOn,
        contentType,
      },
      userDelegationKey,
      accountName,
    );

    return `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasParams.toString()}`;
  } catch {
    // Delegation key unavailable — caller will use multipart fallback
    return "";
  }
}

export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
