/**
 * Proxy API key authentication.
 *
 * Two modes are supported, selected by PROXY_AUTH_MODE (or inferred from
 * PROXY_API_KEY):
 *
 * - shared              : clients send `Authorization: Bearer <PROXY_API_KEY>`;
 *                         Cursor credentials come from the server env.
 * - bring-your-own-key  : clients send `Authorization: Bearer <Cursor API Key>`;
 *                         the proxy only checks a non-placeholder Bearer is
 *                         present; validity is decided by the Cursor CLI.
 * - disabled            : no proxy auth (existing behavior preserved).
 */

import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

export type ProxyAuthMode = "disabled" | "shared" | "bring-your-own-key";

const SHARED = "shared";
const BRING_YOUR_OWN_KEY = "bring-your-own-key";

const PLACEHOLDER_TOKENS = new Set(["not-needed", "no-key", "null"]);

let proxyApiKeys: string[] = [];
let resolvedMode: ProxyAuthMode | null = null;

function normalizeKey(raw: string): string | null {
  const key = raw.trim();
  return key.length > 0 ? key : null;
}

/** Parse and cache PROXY_API_KEY (comma-separated). Returns the loaded keys. */
export function loadProxyApiKeys(): string[] {
  if (resolvedMode !== null) {
    return proxyApiKeys;
  }
  const raw = process.env.PROXY_API_KEY || "";
  proxyApiKeys = raw
    .split(",")
    .map(normalizeKey)
    .filter((k): k is string => k !== null);
  return proxyApiKeys;
}

function parseExplicitMode(raw: string): ProxyAuthMode | null {
  const value = raw.trim().toLowerCase();
  if (value === SHARED) return SHARED;
  if (value === BRING_YOUR_OWN_KEY) return BRING_YOUR_OWN_KEY;
  return null;
}

/** Resolve the active auth mode from env vars. Cached after first call. */
export function getProxyAuthMode(): ProxyAuthMode {
  if (resolvedMode !== null) {
    return resolvedMode;
  }

  const keys = loadProxyApiKeys();
  const explicitRaw = process.env.PROXY_AUTH_MODE;

  if (explicitRaw && explicitRaw.trim() !== "") {
    const explicit = parseExplicitMode(explicitRaw);
    if (explicit === null) {
      throw new Error(
        `Invalid PROXY_AUTH_MODE: "${explicitRaw}". Expected "shared" or "bring-your-own-key".`
      );
    }
    if (explicit === SHARED && keys.length === 0) {
      throw new Error(
        'PROXY_AUTH_MODE=shared requires PROXY_API_KEY to be set.'
      );
    }
    resolvedMode = explicit;
  } else if (keys.length > 0) {
    resolvedMode = SHARED;
  } else {
    resolvedMode = "disabled";
  }

  return resolvedMode;
}

/** Initialize eagerly so config errors surface at startup. */
export function initProxyAuth(): ProxyAuthMode {
  return getProxyAuthMode();
}

export function isProxyAuthEnabled(): boolean {
  return getProxyAuthMode() !== "disabled";
}

/** Extract the Bearer token from the Authorization header. */
export function extractBearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** shared mode: constant-time match against the configured proxy keys. */
export function validateProxyApiKey(token: string): boolean {
  const keys = loadProxyApiKeys();
  let matched = false;
  for (const key of keys) {
    if (safeEqual(token, key)) {
      matched = true;
    }
  }
  return matched;
}

/** bring-your-own-key mode: require a non-placeholder Bearer token. */
export function looksLikeClientCursorKey(token: string | undefined): boolean {
  return (
    !!token &&
    token.length > 0 &&
    !PLACEHOLDER_TOKENS.has(token.toLowerCase())
  );
}

function reject(res: Response): void {
  res.status(401).json({
    error: {
      message: "Incorrect API key provided.",
      type: "invalid_request_error",
      code: "invalid_api_key",
    },
  });
}

export function proxyAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  let mode: ProxyAuthMode;
  try {
    mode = getProxyAuthMode();
  } catch (err) {
    res.status(500).json({
      error: {
        message: err instanceof Error ? err.message : "Proxy auth misconfigured",
        type: "server_error",
        code: "proxy_auth_misconfigured",
      },
    });
    return;
  }

  if (mode === "disabled") {
    next();
    return;
  }

  const token = extractBearerToken(req);

  if (mode === SHARED) {
    if (!token || !validateProxyApiKey(token)) {
      reject(res);
      return;
    }
    next();
    return;
  }

  // bring-your-own-key
  if (!looksLikeClientCursorKey(token)) {
    reject(res);
    return;
  }
  next();
}
