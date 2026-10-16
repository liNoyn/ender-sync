export type IdentityType = "xuid" | "name";
export type EnderAction = "save" | "load" | "status";
export type DynamicPropertyScalar = boolean | number | string;

export interface ResolvedPlayerIdentity {
  identityType: IdentityType;
  playerKey: string;
}

export interface SnapshotSource {
  serverId: string;
  worldId: string;
  worldName: string;
}

export interface SerializedItemStorage {
  size?: number;
  items: Array<SerializedItem | null>;
}

export interface SerializedItem {
  slot?: number;
  typeId: string;
  amount: number;
  nameTag?: string;
  lore?: string[];
  keepOnDeath?: boolean;
  lockMode?: string;
  canDestroy?: string[];
  canPlaceOn?: string[];
  dynamicProperties?: Record<string, DynamicPropertyScalar>;
  durability?: {
    damage?: number;
    unbreakable?: boolean;
  };
  enchantments?: Array<{
    type: string;
    level: number;
  }>;
  storage?: SerializedItemStorage;
}

export interface EnderExclusion {
  slot: number;
  typeId: string;
  reason: "portable_storage_unsupported";
}

export interface EnderSnapshot {
  schemaVersion: number;
  identityType: IdentityType;
  playerKey: string;
  snapshotId: string;
  savedAt: string;
  loadConsumedAt?: string;
  source: SnapshotSource;
  exclusions?: EnderExclusion[];
  /** One entry per Ender Chest slot (27); null for an empty or excluded slot. */
  items: Array<SerializedItem | null>;
}

export interface EnderSaveResponse {
  ok: boolean;
  playerKey: string;
  identityType: IdentityType;
  savedAt: string;
}

export interface EnderLoadResponse {
  ok: boolean;
  found: boolean;
  consumed?: boolean;
  consumedAt?: string;
  playerKey: string;
  identityType: IdentityType;
  savedAt?: string;
  snapshot?: EnderSnapshot;
}

export interface EnderStatusResponse {
  ok: boolean;
  found: boolean;
  consumed?: boolean;
  consumedAt?: string;
  playerKey: string;
  identityType: IdentityType;
  savedAt?: string;
  source?: SnapshotSource;
}

export interface EnderAuditRequest {
  identityType: IdentityType;
  playerKey: string;
  snapshotId?: string;
  snapshotSavedAt?: string;
  source?: SnapshotSource;
  executedSource: SnapshotSource;
  occurredAt?: string;
}

export interface ApiOkResponse {
  ok: boolean;
}

type UnknownRecord = Record<string, unknown>;

export function isEnderAction(value: unknown): value is EnderAction {
  return value === "save" || value === "load" || value === "status";
}

export function isIdentityType(value: unknown): value is IdentityType {
  return value === "name" || value === "xuid";
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isDynamicPropertyRecord(value: unknown): value is Record<string, DynamicPropertyScalar> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) => typeof entry === "boolean" || typeof entry === "number" || typeof entry === "string",
    )
  );
}

function isSerializedItemStorage(value: unknown): value is SerializedItemStorage {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return false;
  }

  if (value.size !== undefined && !isNumber(value.size)) {
    return false;
  }

  return value.items.every((entry) => entry === null || isSerializedItem(entry));
}

export function isSerializedItem(value: unknown): value is SerializedItem {
  if (!isRecord(value) || typeof value.typeId !== "string" || !isNumber(value.amount)) {
    return false;
  }

  if (value.slot !== undefined && !isNumber(value.slot)) return false;
  if (value.nameTag !== undefined && typeof value.nameTag !== "string") return false;
  if (value.lore !== undefined && !isStringArray(value.lore)) return false;
  if (value.keepOnDeath !== undefined && typeof value.keepOnDeath !== "boolean") return false;
  if (value.lockMode !== undefined && typeof value.lockMode !== "string") return false;
  if (value.canDestroy !== undefined && !isStringArray(value.canDestroy)) return false;
  if (value.canPlaceOn !== undefined && !isStringArray(value.canPlaceOn)) return false;
  if (value.dynamicProperties !== undefined && !isDynamicPropertyRecord(value.dynamicProperties)) return false;

  if (value.durability !== undefined) {
    if (!isRecord(value.durability)) return false;
    if (value.durability.damage !== undefined && !isNumber(value.durability.damage)) return false;
    if (value.durability.unbreakable !== undefined && typeof value.durability.unbreakable !== "boolean") return false;
  }

  if (
    value.enchantments !== undefined &&
    (!Array.isArray(value.enchantments) ||
      !value.enchantments.every((entry) => isRecord(entry) && typeof entry.type === "string" && isNumber(entry.level)))
  ) {
    return false;
  }

  if (value.storage !== undefined && !isSerializedItemStorage(value.storage)) return false;

  return true;
}

function isSnapshotSource(value: unknown): value is SnapshotSource {
  return (
    isRecord(value) &&
    typeof value.serverId === "string" &&
    typeof value.worldId === "string" &&
    typeof value.worldName === "string"
  );
}

function isEnderExclusion(value: unknown): value is EnderExclusion {
  return (
    isRecord(value) &&
    isNumber(value.slot) &&
    typeof value.typeId === "string" &&
    value.reason === "portable_storage_unsupported"
  );
}

export function isEnderSnapshot(value: unknown): value is EnderSnapshot {
  return (
    isRecord(value) &&
    isNumber(value.schemaVersion) &&
    isIdentityType(value.identityType) &&
    typeof value.playerKey === "string" &&
    typeof value.snapshotId === "string" &&
    typeof value.savedAt === "string" &&
    (value.loadConsumedAt === undefined || typeof value.loadConsumedAt === "string") &&
    isSnapshotSource(value.source) &&
    (value.exclusions === undefined || (Array.isArray(value.exclusions) && value.exclusions.every(isEnderExclusion))) &&
    Array.isArray(value.items) &&
    value.items.every((entry) => entry === null || isSerializedItem(entry))
  );
}

export function isEnderSaveResponse(value: unknown): value is EnderSaveResponse {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    typeof value.playerKey === "string" &&
    isIdentityType(value.identityType) &&
    typeof value.savedAt === "string"
  );
}

export function isEnderLoadResponse(value: unknown): value is EnderLoadResponse {
  if (
    !isRecord(value) ||
    typeof value.ok !== "boolean" ||
    typeof value.found !== "boolean" ||
    typeof value.playerKey !== "string" ||
    !isIdentityType(value.identityType)
  ) {
    return false;
  }

  if (!value.found || value.consumed) {
    return true;
  }

  return isEnderSnapshot(value.snapshot);
}

export function isEnderStatusResponse(value: unknown): value is EnderStatusResponse {
  if (
    !isRecord(value) ||
    typeof value.ok !== "boolean" ||
    typeof value.found !== "boolean" ||
    typeof value.playerKey !== "string" ||
    !isIdentityType(value.identityType)
  ) {
    return false;
  }

  return !value.found || (typeof value.savedAt === "string" && isSnapshotSource(value.source));
}

export function isApiOkResponse(value: unknown): value is ApiOkResponse {
  return isRecord(value) && typeof value.ok === "boolean";
}
