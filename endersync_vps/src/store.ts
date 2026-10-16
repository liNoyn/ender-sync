import fs from "node:fs/promises";
import path from "node:path";
import { serverConfig } from "./config";
import type { EnderAuditRequest, EnderSnapshot, IdentityType } from "./types";
import { isEnderSnapshot } from "./types";

const fileOperationLocks = new Map<string, Promise<unknown>>();

export class SnapshotConflictError extends Error {
  constructor() {
    super("An unconsumed Ender Chest snapshot already exists for this player.");
    this.name = "SnapshotConflictError";
  }
}

export interface ConsumeResult {
  snapshot?: EnderSnapshot;
  consumed: boolean;
  consumedAt?: string;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return sanitized.length > 0 ? sanitized : "anonymous";
}

// Minecraft names are case-insensitive, so one player maps to one file on every filesystem.
function playerFileName(playerKey: string): string {
  return `${sanitizePathSegment(playerKey.toLowerCase())}.json`;
}

function getSnapshotFilePath(identityType: IdentityType, playerKey: string): string {
  return path.join(serverConfig.dataDir, "ender", identityType, playerFileName(playerKey));
}

function getHistoryFilePath(snapshot: EnderSnapshot): string {
  const stamp = sanitizePathSegment(snapshot.savedAt.replace(/[:.]/g, "-"));
  return path.join(
    serverConfig.dataDir,
    "_history",
    snapshot.identityType,
    sanitizePathSegment(snapshot.playerKey.toLowerCase()),
    `${stamp}-${sanitizePathSegment(snapshot.snapshotId)}.json`,
  );
}

function getAuditFilePath(occurredAt: string): string {
  return path.join(serverConfig.dataDir, "_audit", `${sanitizePathSegment(occurredAt.slice(0, 10) || "unknown-date")}.ndjson`);
}

async function withFileLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileOperationLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const cleanup = run.catch(() => undefined);
  fileOperationLocks.set(key, cleanup);

  try {
    return await run;
  } finally {
    if (fileOperationLocks.get(key) === cleanup) {
      fileOperationLocks.delete(key);
    }
  }
}

// Write to a temp file and rename so a crash never leaves a half-written snapshot.
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

async function readSnapshotFile(filePath: string): Promise<EnderSnapshot | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!isEnderSnapshot(parsed)) {
      throw new Error(`Snapshot at ${filePath} has an invalid shape.`);
    }

    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

/**
 * Stores a snapshot. Refuses (SnapshotConflictError) while a different, unconsumed snapshot exists
 * for the player, so a second save can never silently destroy items the player has not loaded yet.
 * Re-saving the same snapshotId is allowed: the Behavior Pack uses it to roll back a failed load.
 */
export async function saveEnderSnapshot(snapshot: EnderSnapshot): Promise<void> {
  const filePath = getSnapshotFilePath(snapshot.identityType, snapshot.playerKey);
  await withFileLock(filePath, async () => {
    const existing = await readSnapshotFile(filePath);
    if (existing && !existing.loadConsumedAt && existing.snapshotId !== snapshot.snapshotId) {
      throw new SnapshotConflictError();
    }

    const loadable: EnderSnapshot = { ...snapshot };
    delete loadable.loadConsumedAt;
    // History copy first: if the main write fails, the data still exists on disk.
    await writeJsonAtomic(getHistoryFilePath(snapshot), loadable);
    await writeJsonAtomic(filePath, loadable);
  });
}

export function loadEnderSnapshot(identityType: IdentityType, playerKey: string): Promise<EnderSnapshot | undefined> {
  return readSnapshotFile(getSnapshotFilePath(identityType, playerKey));
}

/** Marks the snapshot consumed and returns it. The second caller sees `consumed: true` and no items. */
export async function consumeEnderSnapshot(identityType: IdentityType, playerKey: string): Promise<ConsumeResult> {
  const filePath = getSnapshotFilePath(identityType, playerKey);
  return withFileLock(filePath, async () => {
    const snapshot = await readSnapshotFile(filePath);
    if (!snapshot) {
      return { consumed: false };
    }

    if (snapshot.loadConsumedAt) {
      return { snapshot, consumed: true, consumedAt: snapshot.loadConsumedAt };
    }

    const consumedAt = new Date().toISOString();
    const consumedSnapshot: EnderSnapshot = { ...snapshot, loadConsumedAt: consumedAt };
    await writeJsonAtomic(filePath, consumedSnapshot);
    return { snapshot: consumedSnapshot, consumed: false, consumedAt };
  });
}

export interface AuditEvent {
  action: "save" | "load";
  occurredAt: string;
  identityType: IdentityType;
  playerKey: string;
  snapshotId?: string;
  snapshotSavedAt?: string;
  source?: EnderAuditRequest["source"];
  executedSource?: EnderAuditRequest["executedSource"];
}

export async function appendAuditEvent(event: AuditEvent): Promise<void> {
  const filePath = getAuditFilePath(event.occurredAt);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
}
