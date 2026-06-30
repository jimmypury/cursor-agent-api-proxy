/**
 * Dynamic model list via `agent --list-models`.
 *
 * Caching strategy:
 * - shared mode: pre-warmed at startup, TTL ~6h (refreshes on expiry).
 * - lazy mode (disabled / bring-your-own-key): fetched on first request,
 *   the last successful result is kept and served afterwards.
 *
 * No hardcoded fallback. If the CLI call fails, the error propagates to the
 * caller (the route returns it to the client).
 */

import { spawn } from "child_process";
import type { ProxyAuthMode } from "../server/auth.js";

const IS_WIN = process.platform === "win32";
const SHARED_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const LIST_TIMEOUT_MS = 15_000;

interface CacheEntry {
  ids: string[];
  fetchedAt: number;
}

let sharedCache: CacheEntry | null = null;
let lazyCache: CacheEntry | null = null;

/** Spawn `agent --list-models` and parse the plain-text output into model ids. */
export async function listCursorModels(apiKey?: string): Promise<string[]> {
  const args = ["--list-models"];
  const env = { ...process.env };
  if (apiKey) {
    env.CURSOR_API_KEY = apiKey;
  }

  return new Promise<string[]>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const proc = spawn("agent", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      shell: IS_WIN,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill(IS_WIN ? undefined : "SIGTERM");
      } catch {}
      reject(new Error(`agent --list-models timed out after ${LIST_TIMEOUT_MS}ms`));
    }, LIST_TIMEOUT_MS);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          IS_WIN
            ? "Cursor CLI (agent) not found."
            : "Cursor CLI (agent) not found. Install: curl https://cursor.com/install -fsS | bash"
        )
      );
    });

    proc.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (code !== 0) {
        settled = true;
        const reason = stderr.trim() || `agent --list-models exited with code ${code}`;
        reject(new Error(reason));
        return;
      }
      const ids = parseModelList(stdout);
      if (ids.length === 0) {
        settled = true;
        reject(new Error("agent --list-models returned no models"));
        return;
      }
      settled = true;
      resolve(ids);
    });
  });
}

/**
 * Parse the text output of `agent --list-models`.
 *
 * Format:
 *   Available models
 *   <blank>
 *   <id> - <display name>
 *   ...
 *   <blank>
 *   Tip: use --model <id> ...
 */
export function parseModelList(output: string): string[] {
  const ids: string[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "Available models") continue;
    if (line.startsWith("Tip:")) continue;
    const sep = line.indexOf(" - ");
    if (sep <= 0) continue;
    const id = line.slice(0, sep).trim();
    if (id) ids.push(id);
  }
  return ids;
}

function isFresh(entry: CacheEntry, ttlMs: number): boolean {
  return Date.now() - entry.fetchedAt < ttlMs;
}

/**
 * Return the model id list, using the caching strategy for the given mode.
 * Throws on CLI failure (no fallback).
 */
export async function getModels(
  mode: ProxyAuthMode,
  apiKey?: string
): Promise<string[]> {
  if (mode === "shared") {
    if (sharedCache && isFresh(sharedCache, SHARED_TTL_MS)) {
      return sharedCache.ids;
    }
    const ids = await listCursorModels(apiKey);
    sharedCache = { ids, fetchedAt: Date.now() };
    return ids;
  }

  // lazy (disabled / bring-your-own-key): keep last successful result
  if (lazyCache) {
    return lazyCache.ids;
  }
  const ids = await listCursorModels(apiKey);
  lazyCache = { ids, fetchedAt: Date.now() };
  return ids;
}

/** Pre-warm the shared cache at startup. Logs failures but does not throw. */
export async function warmModels(
  mode: ProxyAuthMode,
  apiKey?: string
): Promise<void> {
  if (mode !== "shared") return;
  try {
    await getModels(mode, apiKey);
    console.log(`  Models: pre-warmed (${sharedCache?.ids.length ?? 0} models)`);
  } catch (err) {
    console.error(
      `  Models: warmup failed: ${err instanceof Error ? err.message : err}`
    );
  }
}
