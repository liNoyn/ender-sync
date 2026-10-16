import { CommandPermissionLevel } from "@minecraft/server";

export const config = {
  schemaVersion: 1,
  namespace: "endersync",
  apiBaseUrl: "https://your-endersync-api.example.com",
  apiToken: "replace-me",
  requestTimeoutMs: 60000,
  serverId: "server-a",
  worldId: "world_a",
  worldName: "World A",
  commandPermissionLevel: CommandPermissionLevel.Any,
} as const;
