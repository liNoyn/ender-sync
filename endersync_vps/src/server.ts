import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { assertServerConfig, serverConfig } from "./config";
import {
  appendAuditEvent,
  consumeEnderSnapshot,
  loadEnderSnapshot,
  saveEnderSnapshot,
  SnapshotConflictError,
  type AuditEvent,
} from "./store";
import type { EnderAuditRequest, IdentityType } from "./types";
import { isEnderSnapshot, isIdentityType, isRecord } from "./types";

function sendJsonError(response: Response, status: number, message: string): void {
  response.status(status).json({ ok: false, error: message });
}

function tokensMatch(provided: string | undefined): boolean {
  if (!provided) {
    return false;
  }

  const expected = Buffer.from(serverConfig.apiToken);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function getBearerToken(request: Request): string | undefined {
  return request.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function readLookup(request: Request): { identityType: IdentityType; playerKey: string } | undefined {
  const { identityType, playerKey } = request.query;
  if (!isIdentityType(identityType) || typeof playerKey !== "string" || playerKey.length === 0) {
    return undefined;
  }

  return { identityType, playerKey };
}

function isSource(value: unknown): value is NonNullable<EnderAuditRequest["source"]> {
  return (
    isRecord(value) &&
    typeof value.serverId === "string" &&
    typeof value.worldId === "string" &&
    typeof value.worldName === "string"
  );
}

function isAuditRequest(value: unknown): value is EnderAuditRequest {
  return (
    isRecord(value) &&
    isIdentityType(value.identityType) &&
    typeof value.playerKey === "string" &&
    isSource(value.executedSource) &&
    (value.source === undefined || isSource(value.source)) &&
    (value.snapshotId === undefined || typeof value.snapshotId === "string") &&
    (value.snapshotSavedAt === undefined || typeof value.snapshotSavedAt === "string") &&
    (value.occurredAt === undefined || typeof value.occurredAt === "string")
  );
}

async function tryAppendAuditEvent(event: AuditEvent): Promise<void> {
  try {
    await appendAuditEvent(event);
  } catch (error) {
    console.error("[EnderSync API] Failed to append audit log", error);
  }
}

function main(): void {
  assertServerConfig();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: serverConfig.jsonBodyLimit }));

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!tokensMatch(getBearerToken(request))) {
      sendJsonError(response, 401, "Unauthorized");
      return;
    }

    next();
  });

  app.post("/api/ender/save", async (request, response, next) => {
    try {
      if (!isEnderSnapshot(request.body)) {
        sendJsonError(response, 400, "Invalid snapshot payload");
        return;
      }

      await saveEnderSnapshot(request.body);
      await tryAppendAuditEvent({
        action: "save",
        occurredAt: new Date().toISOString(),
        identityType: request.body.identityType,
        playerKey: request.body.playerKey,
        snapshotId: request.body.snapshotId,
        snapshotSavedAt: request.body.savedAt,
        source: request.body.source,
      });

      response.json({
        ok: true,
        playerKey: request.body.playerKey,
        identityType: request.body.identityType,
        savedAt: request.body.savedAt,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/ender/load", async (request, response, next) => {
    try {
      const lookup = readLookup(request);
      if (!lookup) {
        sendJsonError(response, 400, "Invalid query");
        return;
      }

      const result = await consumeEnderSnapshot(lookup.identityType, lookup.playerKey);
      if (!result.snapshot) {
        response.json({ ok: true, found: false, consumed: false, ...lookup });
        return;
      }

      const base = {
        ok: true,
        found: true,
        playerKey: result.snapshot.playerKey,
        identityType: result.snapshot.identityType,
        savedAt: result.snapshot.savedAt,
      };
      if (result.consumed) {
        response.json({ ...base, consumed: true, consumedAt: result.consumedAt });
        return;
      }

      response.json({ ...base, consumed: false, consumedAt: result.consumedAt, snapshot: result.snapshot });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/ender/status", async (request, response, next) => {
    try {
      const lookup = readLookup(request);
      if (!lookup) {
        sendJsonError(response, 400, "Invalid query");
        return;
      }

      const snapshot = await loadEnderSnapshot(lookup.identityType, lookup.playerKey);
      if (!snapshot) {
        response.json({ ok: true, found: false, ...lookup });
        return;
      }

      response.json({
        ok: true,
        found: true,
        consumed: Boolean(snapshot.loadConsumedAt),
        consumedAt: snapshot.loadConsumedAt,
        playerKey: snapshot.playerKey,
        identityType: snapshot.identityType,
        savedAt: snapshot.savedAt,
        source: snapshot.source,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ender/audit/load", async (request, response, next) => {
    try {
      if (!isAuditRequest(request.body)) {
        sendJsonError(response, 400, "Invalid audit payload");
        return;
      }

      await tryAppendAuditEvent({
        action: "load",
        occurredAt: request.body.occurredAt ?? new Date().toISOString(),
        identityType: request.body.identityType,
        playerKey: request.body.playerKey,
        snapshotId: request.body.snapshotId,
        snapshotSavedAt: request.body.snapshotSavedAt,
        source: request.body.source,
        executedSource: request.body.executedSource,
      });
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.use((_request: Request, response: Response) => {
    sendJsonError(response, 404, "Not found");
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof SyntaxError) {
      sendJsonError(response, 400, "Invalid JSON");
      return;
    }

    if (error instanceof SnapshotConflictError) {
      sendJsonError(response, 409, error.message);
      return;
    }

    console.error("[EnderSync API] Unexpected error", error);
    sendJsonError(response, 500, "Internal server error");
  });

  app.listen(serverConfig.port, serverConfig.host, () => {
    console.info(`[EnderSync API] Listening on ${serverConfig.host}:${serverConfig.port}`);
  });
}

try {
  main();
} catch (error) {
  console.error("[EnderSync API] Failed to start", error);
  process.exitCode = 1;
}
