# Changelog

## Unreleased

- Ender Chest–only sync, written on the same idea as rometet/inventory-sync (Behavior Pack + Node.js API).
- Commands: `/endersync:save`, `/endersync:load`, `/endersync:status`.
- The API refuses to overwrite an unconsumed snapshot, consumes a snapshot exactly once, writes atomically, and keeps a history copy of every save.
- A failed restore empties the slots it touched and puts the snapshot back.
- No regular inventory sync, DB mode, XP handling, or FTP/SSH sources.