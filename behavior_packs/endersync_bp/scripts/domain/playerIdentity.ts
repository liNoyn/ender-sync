// Derived from rometet/inventory-sync (https://github.com/rometet/inventory-sync) by rometet.
// Adapted for Ender Sync; see the Credits section of the root README.

import { Player } from "@minecraft/server";
import type { ResolvedPlayerIdentity } from "./types";

export interface PlayerIdentityResolver {
  resolve(player: Player): ResolvedPlayerIdentity;
}

class DefaultPlayerIdentityResolver implements PlayerIdentityResolver {
  resolve(player: Player): ResolvedPlayerIdentity {
    // TODO: Switch this resolver to XUID when script APIs expose it reliably.
    return {
      identityType: "name",
      playerKey: player.name,
    };
  }
}

export const playerIdentityResolver: PlayerIdentityResolver = new DefaultPlayerIdentityResolver();
