import { system } from "@minecraft/server";
import { registerEnderCommands } from "./commands/enderCommand";

system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
  registerEnderCommands(customCommandRegistry);
});
