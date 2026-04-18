/**
 * Shared Google OAuth token refresh helper.
 * Used by both the manual import route (google-import.ts) and the background auto-sync worker.
 */

import { logger } from "./logger.js";

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

/**
 * Exchanges a Google refresh token for a fresh access token.
 * Returns the new access token, or undefined if the refresh failed
 * (expired grant, revoked access, network error, etc.).
 */
export async function refreshGoogleAccessToken(refreshToken: string): Promise<string | undefined> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    logger.warn("[google-auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured");
    return undefined;
  }
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type:    "refresh_token",
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "[google-auth] token refresh failed");
      return undefined;
    }
    const data = await res.json() as { access_token?: string };
    return data.access_token;
  } catch (err) {
    logger.warn({ err: String(err) }, "[google-auth] token refresh threw");
    return undefined;
  }
}
