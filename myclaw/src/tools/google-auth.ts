/**
 * Google Auth — Per-user OAuth2 + .env fallback
 * ใช้ร่วมกันระหว่าง Gmail, Calendar, Drive, Sheets tools
 *
 * ลำดับ: per-user token (DB) → .env GOOGLE_REFRESH_TOKEN → null
 */

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { getUserTokens, isUserLinked, saveUserTokens } from "../google/store.js";

// .env-based singleton (backward compat)
let _envClient: OAuth2Client | null = null;

// Per-user client cache
const _userClients = new Map<string, OAuth2Client>();

function getDataDir(): string {
  return process.env.DATA_DIR || "./data";
}

/** Check if .env has shared Google credentials */
export function isGoogleConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID?.trim() &&
    process.env.GOOGLE_CLIENT_SECRET?.trim() &&
    process.env.GOOGLE_REFRESH_TOKEN?.trim()
  );
}

/** Get .env-based shared OAuth2Client (backward compat) */
export function getGoogleAuth(): OAuth2Client {
  if (_envClient) return _envClient;

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google API not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN in .env",
    );
  }

  _envClient = new google.auth.OAuth2(clientId, clientSecret);
  _envClient.setCredentials({ refresh_token: refreshToken });
  return _envClient;
}

/** Check if a LINE user has linked their Google account */
export function isUserGoogleLinked(userId: string): boolean {
  try {
    return isUserLinked(getDataDir(), userId);
  } catch {
    return false;
  }
}

/**
 * Get OAuth2Client for a specific user
 * Priority: per-user token → .env fallback → null
 */
export function getUserGoogleAuth(userId: string): OAuth2Client | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) return null;

  // 1. Try per-user tokens
  try {
    const tokens = getUserTokens(getDataDir(), userId);
    if (tokens) {
      // Check cache
      const cached = _userClients.get(userId);
      if (cached) return cached;

      const client = new google.auth.OAuth2(clientId, clientSecret);
      client.setCredentials({
        refresh_token: tokens.refreshToken,
        access_token: tokens.accessToken || undefined,
        expiry_date: tokens.expiry || undefined,
      });

      // Auto-update access token in DB on refresh
      client.on("tokens", (newTokens) => {
        if (newTokens.access_token) {
          try {
            saveUserTokens(getDataDir(), {
              userId,
              refreshToken: tokens.refreshToken,
              accessToken: newTokens.access_token,
              expiry: newTokens.expiry_date || undefined,
            });
          } catch (err) {
            console.error("[google-auth] Failed to save refreshed token:", err);
          }
        }
      });

      _userClients.set(userId, client);
      return client;
    }
  } catch {
    // DB not ready or other error, fall through
  }

  // 2. Fall back to .env shared token
  if (isGoogleConfigured()) {
    return getGoogleAuth();
  }

  return null;
}

/** Clear cached client for a user (call on unlink) */
export function clearUserGoogleAuth(userId: string): void {
  _userClients.delete(userId);
}
