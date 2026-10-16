import {
  CustomCommandOrigin,
  CustomCommandRegistry,
  CustomCommandSource,
  CustomCommandStatus,
  Player,
} from "@minecraft/server";
import { playerIdentityResolver } from "../domain/playerIdentity";
import type { EnderAction, EnderSnapshot } from "../domain/types";
import {
  applyEnderSnapshot,
  clearSyncedEnderChest,
  countSavedEnderItems,
  createEnderSnapshot,
  describeEnderExclusions,
} from "../inventory/enderChest";
import { ApiClientError, fetchSnapshotStatus, loadSnapshot, recordLoadApplied, saveSnapshot } from "../net/apiClient";
import { sendError, sendInfo, sendLines, sendSuccess } from "../util/chat";
import { config } from "../util/config";
import { logger } from "../util/logger";

const ACTIONS: readonly EnderAction[] = ["save", "load", "status"];

// Players with an operation in flight; prevents two overlapping requests per player.
const busyPlayers = new Set<string>();

function getPlayerFromOrigin(origin: CustomCommandOrigin): Player | undefined {
  if (origin.sourceType !== CustomCommandSource.Entity) {
    return undefined;
  }

  const entity = origin.sourceEntity;
  if (!entity || entity.typeId !== "minecraft:player") {
    return undefined;
  }

  return entity as Player;
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

async function handleSave(player: Player): Promise<void> {
  const identity = playerIdentityResolver.resolve(player);

  // The API also refuses to overwrite an unconsumed snapshot; this check just gives a clearer message.
  const status = await fetchSnapshotStatus(identity.identityType, identity.playerKey);
  if (status.found && !status.consumed) {
    sendError(player, "未適用のエンダーチェスト保存データがあります。上書きを防ぐため、先に /endersync:load で復元してください。");
    return;
  }

  const snapshot = createEnderSnapshot(player, identity);
  const itemCount = countSavedEnderItems(snapshot);
  const excluded = describeEnderExclusions(snapshot);

  if (itemCount === 0) {
    sendInfo(
      player,
      excluded.length > 0
        ? `保存できるアイテムがありません。Script APIで中身を読めない携帯収納は対象外です: ${excluded.join(", ")}`
        : "エンダーチェストが空のため、保存しませんでした。",
    );
    return;
  }

  const response = await saveSnapshot(snapshot);

  try {
    await clearSyncedEnderChest(player, snapshot);
  } catch (error) {
    logger.error("Ender Chest snapshot was saved, but clearing the Ender Chest failed.", describeError(error));
    sendError(
      player,
      `エンダーチェストは保存されましたが、保存後のclearに失敗しました。アイテムが二重にならないよう、運営に連絡してください。詳細: ${describeError(error)}`,
    );
    return;
  }

  sendSuccess(player, `エンダーチェスト(${itemCount}スロット)を保存し、clearしました。(${response.savedAt})`);
  if (excluded.length > 0) {
    sendInfo(player, `Script APIで中身を読めない携帯収納は、消失防止のため保存せず残しました: ${excluded.join(", ")}`);
  }
}

async function applyLoaded(player: Player, snapshot: EnderSnapshot): Promise<void> {
  try {
    const result = await applyEnderSnapshot(player, snapshot);
    try {
      await recordLoadApplied(snapshot);
    } catch (error) {
      logger.warn("Failed to record the Ender Chest load audit event.", describeError(error));
    }
    sendSuccess(player, `エンダーチェストを復元しました。(${result.placedSlots}スロット / 保存日時: ${snapshot.savedAt})`);
  } catch (error) {
    // The API already marked the snapshot as consumed; put it back so nothing is lost.
    try {
      await saveSnapshot({ ...snapshot, loadConsumedAt: undefined });
      sendError(
        player,
        `エンダーチェストの復元に失敗しました。保存データは元に戻したので、問題を解消してからもう一度loadしてください。詳細: ${describeError(error)}`,
      );
    } catch (restoreError) {
      logger.error("Ender Chest restore failed and the snapshot could not be re-saved.", describeError(restoreError));
      sendError(
        player,
        `エンダーチェストの復元に失敗し、保存データの巻き戻しにも失敗しました。運営に連絡してください(snapshotId=${snapshot.snapshotId})。詳細: ${describeError(error)}`,
      );
    }
  }
}

async function handleLoad(player: Player): Promise<void> {
  const identity = playerIdentityResolver.resolve(player);

  const response = await loadSnapshot(identity.identityType, identity.playerKey);
  if (!response.found) {
    sendInfo(player, "保存済みのエンダーチェストが見つかりません。");
    return;
  }

  if (response.consumed || !response.snapshot) {
    sendInfo(player, "エンダーチェストの保存データはすでに適用済みです。必要なら新しく save してください。");
    return;
  }

  await applyLoaded(player, response.snapshot);
}

async function handleStatus(player: Player): Promise<void> {
  const identity = playerIdentityResolver.resolve(player);
  const response = await fetchSnapshotStatus(identity.identityType, identity.playerKey);

  if (!response.found) {
    sendLines(player, "§eエンダーチェスト保存状況", [`playerKey: ${identity.playerKey}`, "保存済み: いいえ"]);
    return;
  }

  sendLines(player, "§eエンダーチェスト保存状況", [
    `playerKey: ${response.playerKey}`,
    "保存済み: はい",
    `適用済み: ${response.consumed ? "はい" : "いいえ"}`,
    `適用日時: ${response.consumedAt ?? "未適用"}`,
    `保存日時: ${response.savedAt ?? "不明"}`,
    `保存元: ${response.source?.worldName ?? "不明"} (${response.source?.serverId ?? "不明"} / ${response.source?.worldId ?? "不明"})`,
  ]);
}

async function runAction(player: Player, action: EnderAction): Promise<void> {
  if (busyPlayers.has(player.name)) {
    sendInfo(player, "前のエンダーチェスト操作が完了するまでお待ちください。");
    return;
  }

  busyPlayers.add(player.name);
  try {
    switch (action) {
      case "save":
        await handleSave(player);
        return;
      case "load":
        await handleLoad(player);
        return;
      case "status":
        await handleStatus(player);
        return;
    }
  } catch (error) {
    logger.error(`Ender Chest command failed for action "${action}".`, error);

    if (error instanceof ApiClientError) {
      sendError(player, error.playerMessage);
      return;
    }

    sendError(player, `エンダーチェスト操作(${action})に失敗しました。詳細: ${describeError(error)}`);
  } finally {
    busyPlayers.delete(player.name);
  }
}

export function registerEnderCommands(customCommandRegistry: CustomCommandRegistry): void {
  const descriptions: Record<EnderAction, string> = {
    save: "エンダーチェストを保存し、保存後にclearします。",
    load: "保存済みのエンダーチェストを即時復元します。",
    status: "エンダーチェストの保存状況を確認します。",
  };

  for (const action of ACTIONS) {
    customCommandRegistry.registerCommand(
      {
        name: `${config.namespace}:${action}`,
        description: descriptions[action],
        permissionLevel: config.commandPermissionLevel,
      },
      (origin) => {
        const player = getPlayerFromOrigin(origin);
        if (!player) {
          return { status: CustomCommandStatus.Failure, message: "このコマンドはプレイヤーのみ実行できます。" };
        }

        void runAction(player, action);
        return undefined;
      },
    );
  }

  logger.info("Commands registered.", ACTIONS.map((action) => `${config.namespace}:${action}`));
}
