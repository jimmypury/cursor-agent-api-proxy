/**
 * API route handlers — OpenAI-compatible endpoints backed by Cursor CLI.
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { CursorSubprocess } from "../subprocess/manager.js";
import type { ContentDeltaEvent, ResultEvent } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import {
  createStreamChunk,
  createDoneChunk,
  createChatResponse,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import { getProxyAuthMode } from "./auth.js";
import { getModels } from "../subprocess/models.js";

function extractApiKey(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token && token !== "not-needed" && token !== "no-key" && token !== "null") {
      return token;
    }
  }
  return undefined;
}

/**
 * Resolve the Cursor API key to forward to the agent CLI.
 *
 * - disabled: keep existing behavior (client Bearer may carry a Cursor key).
 * - shared:   Bearer is the proxy key; Cursor credentials come from the server env.
 * - bring-your-own-key: client Bearer is the user's own Cursor key.
 */
function resolveCursorApiKey(req: Request): string | undefined {
  const mode = getProxyAuthMode();

  if (mode === "shared") {
    return process.env.CURSOR_API_KEY || undefined;
  }
  return extractApiKey(req);
}

export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    if (
      !body.messages ||
      !Array.isArray(body.messages) ||
      body.messages.length === 0
    ) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    const { prompt, model } = openaiToCli(body);
    const apiKey = resolveCursorApiKey(req);
    console.error(
      `[chat] id=${requestId} model=${body.model} -> cli_model=${model} stream=${stream}`
    );

    const subprocess = new CursorSubprocess();

    if (stream) {
      await handleStreamingResponse(res, subprocess, prompt, model, requestId, apiKey);
    } else {
      await handleNonStreamingResponse(res, subprocess, prompt, model, requestId, apiKey);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[chat] Error:", message);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ error: { message, type: "server_error", code: null } });
    }
  }
}

async function handleStreamingResponse(
  res: Response,
  subprocess: CursorSubprocess,
  prompt: string,
  model: string,
  requestId: string,
  apiKey?: string
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);
  res.flushHeaders();

  res.write(":ok\n\n");

  return new Promise<void>((resolve) => {
    let isFirst = true;
    let lastModel = model;
    let isComplete = false;

    res.on("close", () => {
      if (!isComplete) subprocess.kill();
      resolve();
    });

    subprocess.on("content_delta", (delta: ContentDeltaEvent) => {
      if (delta.text && !res.writableEnded) {
        const chunk = createStreamChunk(requestId, lastModel, delta.text, isFirst);
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
      }
    });

    subprocess.on("result", (result: ResultEvent) => {
      isComplete = true;
      if (result.model) lastModel = result.model;
      if (!res.writableEnded) {
        const done = createDoneChunk(requestId, lastModel);
        res.write(`data: ${JSON.stringify(done)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[stream] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          res.write(
            `data: ${JSON.stringify({
              error: {
                message: `Process exited with code ${code}`,
                type: "server_error",
                code: null,
              },
            })}\n\n`
          );
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.start(prompt, { model, apiKey }).catch((err) => {
      console.error("[stream] Start error:", err);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: err instanceof Error ? err.message : String(err),
              type: "server_error",
              code: null,
            },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });
  });
}

async function handleNonStreamingResponse(
  res: Response,
  subprocess: CursorSubprocess,
  prompt: string,
  model: string,
  requestId: string,
  apiKey?: string
): Promise<void> {
  return new Promise<void>((resolve) => {
    let finalResult: ResultEvent | null = null;

    subprocess.on("result", (result: ResultEvent) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[non-stream] Error:", error.message);
      if (!res.headersSent) {
        res.status(500).json({
          error: { message: error.message, type: "server_error", code: null },
        });
      }
      resolve();
    });

    subprocess.on("close", () => {
      if (finalResult) {
        const response = createChatResponse(
          requestId,
          finalResult.model || model,
          finalResult.text
        );
        res.json(response);
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: "CLI exited without producing a result",
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    subprocess.start(prompt, { model, apiKey }).catch((error) => {
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });
  });
}

export async function handleModels(req: Request, res: Response): Promise<void> {
  try {
    const mode = getProxyAuthMode();
    const apiKey = resolveCursorApiKey(req);
    const ids = await getModels(mode, apiKey);
    const now = Math.floor(Date.now() / 1000);

    res.json({
      object: "list",
      data: ids.map((id) => ({
        id,
        object: "model" as const,
        owned_by: "cursor",
        created: now,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list models";
    console.error("[models] Error:", message);
    res.status(502).json({
      error: {
        message,
        type: "upstream_error",
        code: "cursor_cli_error",
      },
    });
  }
}

let cachedCliVersion: string | undefined;

export function setCachedCliVersion(version: string): void {
  cachedCliVersion = version;
}

export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "cursor-agent-api-proxy",
    cli_version: cachedCliVersion ?? "unknown",
    timestamp: new Date().toISOString(),
  });
}
