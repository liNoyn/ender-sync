import {
  Container,
  EntityComponentTypes,
  EntityEnderInventoryComponent,
  ItemStack,
  Player,
  system,
} from "@minecraft/server";
import type { EnderSnapshot, ResolvedPlayerIdentity, SerializedItem } from "../domain/types";
import { isEnderSnapshot } from "../domain/types";
import { config } from "../util/config";
import { logger } from "../util/logger";
import { deserializeItem, hydrateItemStorage } from "./itemDeserializer";
import { serializeItem } from "./itemSerializer";

const STORAGE_ITEM_TYPE_PATTERN = /(?:^minecraft:)?(?:[a-z_]+_)?shulker_box$/;

export interface ApplyEnderChestResult {
  placedSlots: number;
}

function getEnderContainer(player: Player): Container {
  const ender = player.getComponent(EntityComponentTypes.EnderInventory) as EntityEnderInventoryComponent | undefined;
  if (!ender) {
    throw new Error("minecraft:ender_inventory component is not available for this player.");
  }

  return ender.container;
}

function readSlot(container: Container, slot: number): ItemStack | undefined {
  try {
    return container.getItem(slot);
  } catch (error) {
    throw new Error(`Failed to read Ender Chest slot ${slot}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Reads the player's Ender Chest. Slots that cannot be serialized safely (for example a shulker
 * box whose contents are unreadable) are listed in `exclusions` and are never cleared or restored.
 */
export function createEnderSnapshot(player: Player, identity: ResolvedPlayerIdentity): EnderSnapshot {
  const container = getEnderContainer(player);
  const exclusions: NonNullable<EnderSnapshot["exclusions"]> = [];

  const items = Array.from({ length: container.size }, (_, slot) => {
    const item = readSlot(container, slot);
    if (!item) {
      return null;
    }

    const serialized = serializeItem(item, slot);
    if (!serialized || (STORAGE_ITEM_TYPE_PATTERN.test(item.typeId) && !serialized.storage)) {
      exclusions.push({ slot, typeId: item.typeId, reason: "portable_storage_unsupported" });
      return null;
    }

    return serialized;
  });

  return {
    schemaVersion: config.schemaVersion,
    identityType: identity.identityType,
    playerKey: identity.playerKey,
    snapshotId: `ender-${identity.identityType}-${Date.now()}`,
    savedAt: new Date().toISOString(),
    source: {
      serverId: config.serverId,
      worldId: config.worldId,
      worldName: config.worldName,
    },
    exclusions: exclusions.length > 0 ? exclusions : undefined,
    items,
  };
}

export function countSavedEnderItems(snapshot: EnderSnapshot): number {
  return snapshot.items.filter((item) => item !== null).length;
}

export function describeEnderExclusions(snapshot: EnderSnapshot): string[] {
  return (snapshot.exclusions ?? []).map((entry) => `slot ${entry.slot} (${entry.typeId})`);
}

function comparableItems(snapshot: EnderSnapshot): string {
  return JSON.stringify(snapshot.items);
}

/**
 * Clears only the slots captured in `saved`. Re-reads the chest first and aborts without touching
 * anything if it changed since the snapshot was taken.
 */
export function clearSyncedEnderChest(player: Player, saved: EnderSnapshot): Promise<void> {
  return new Promise((resolve, reject) => {
    system.run(() => {
      try {
        if (!player.isValid) {
          throw new Error("Player became invalid before Ender Chest clearing started.");
        }

        const identity = { identityType: saved.identityType, playerKey: saved.playerKey };
        if (comparableItems(createEnderSnapshot(player, identity)) !== comparableItems(saved)) {
          throw new Error("Ender Chest changed while the save was in flight; nothing was cleared.");
        }

        const container = getEnderContainer(player);
        saved.items.forEach((item, index) => {
          if (item) {
            container.setItem(item.slot ?? index, undefined);
          }
        });

        if (countSavedEnderItems(createEnderSnapshot(player, identity)) !== 0) {
          throw new Error("Ender Chest clear could not be verified.");
        }

        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function placeItem(container: Container, slot: number, data: SerializedItem): void {
  container.setItem(slot, deserializeItem(data));
  if (!data.storage) {
    return;
  }

  const placed = container.getItem(slot);
  if (!placed) {
    throw new Error(`Could not re-read Ender Chest slot ${slot} after placing a storage item.`);
  }

  container.setItem(slot, hydrateItemStorage(placed, data));
}

/**
 * Writes the snapshot into the Ender Chest. Fails before changing anything if a target slot is
 * already occupied; other occupied slots are left alone. Verifies the result and empties the
 * slots it touched again if verification fails.
 */
export function applyEnderSnapshot(player: Player, value: unknown): Promise<ApplyEnderChestResult> {
  if (!isEnderSnapshot(value)) {
    throw new Error("Ender Chest snapshot payload is invalid.");
  }

  const snapshot = value;
  return new Promise((resolve, reject) => {
    system.run(() => {
      const touched: number[] = [];
      try {
        if (!player.isValid) {
          throw new Error("Player became invalid before Ender Chest restoration started.");
        }

        const container = getEnderContainer(player);
        const entries = snapshot.items.flatMap((item, index) => (item ? [{ slot: item.slot ?? index, item }] : []));

        for (const { slot } of entries) {
          if (slot < 0 || slot >= container.size) {
            throw new Error(`Saved slot ${slot} is outside the current Ender Chest size ${container.size}.`);
          }
          if (readSlot(container, slot)) {
            throw new Error(`Ender Chest slot ${slot} is not empty. Empty it before loading.`);
          }
        }

        // Validate every item before the first write.
        for (const { item } of entries) {
          deserializeItem(item);
        }

        for (const { slot, item } of entries) {
          touched.push(slot);
          placeItem(container, slot, item);
        }

        const applied = createEnderSnapshot(player, {
          identityType: snapshot.identityType,
          playerKey: snapshot.playerKey,
        });
        for (const { slot, item } of entries) {
          const actual = applied.items[slot];
          if (!actual || JSON.stringify({ ...actual, slot }) !== JSON.stringify({ ...item, slot })) {
            throw new Error(`Ender Chest slot ${slot} did not match the saved data after restoration.`);
          }
        }

        resolve({ placedSlots: entries.length });
      } catch (error) {
        for (const slot of touched) {
          try {
            getEnderContainer(player).setItem(slot, undefined);
          } catch (rollbackError) {
            logger.warn("Failed to empty an Ender Chest slot after a failed restore.", {
              slot,
              error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
          }
        }
        reject(error);
      }
    });
  });
}
