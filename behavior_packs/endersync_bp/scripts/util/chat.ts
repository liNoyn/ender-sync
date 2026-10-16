// Derived from rometet/inventory-sync (https://github.com/rometet/inventory-sync) by rometet.
// Adapted for Ender Sync; see the Credits section of the root README.

import { Player } from "@minecraft/server";

const PREFIX = "\u00A76[EnderSync]\u00A7r";

function send(player: Player, message: string): void {
  if (!player.isValid) {
    return;
  }

  player.sendMessage(`${PREFIX} ${message}`);
}

export function sendInfo(player: Player, message: string): void {
  send(player, `\u00A77${message}`);
}

export function sendSuccess(player: Player, message: string): void {
  send(player, `\u00A7a${message}`);
}

export function sendError(player: Player, message: string): void {
  send(player, `\u00A7c${message}`);
}

export function sendLines(player: Player, title: string, lines: string[]): void {
  send(
    player,
    [title, ...lines.map((line) => `\u00A77- ${line}`)].join("\n"),
  );
}
