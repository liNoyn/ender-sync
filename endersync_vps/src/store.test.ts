import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { EnderSnapshot } from "./types";

let store: typeof import("./store");
let dataDir: string;

function snapshot(snapshotId: string, overrides: Partial<EnderSnapshot> = {}): EnderSnapshot {
  return {
    schemaVersion: 1,
    identityType: "name",
    playerKey: "Steve",
    snapshotId,
    savedAt: new Date().toISOString(),
    source: { serverId: "a", worldId: "w", worldName: "World" },
    items: [{ slot: 0, typeId: "minecraft:diamond", amount: 3 }, ...Array.from({ length: 26 }, () => null)],
    ...overrides,
  };
}

describe("ender snapshot store", () => {
  before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "endersync-test-"));
    process.env.ENDERSYNC_DATA_DIR = dataDir;
    store = await import("./store");
  });

  after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("returns nothing for an unknown player", async () => {
    assert.equal(await store.loadEnderSnapshot("name", "nobody"), undefined);
    assert.deepEqual(await store.consumeEnderSnapshot("name", "nobody"), { consumed: false });
  });

  it("consumes a snapshot exactly once and treats names case-insensitively", async () => {
    await store.saveEnderSnapshot(snapshot("s1"));

    const first = await store.consumeEnderSnapshot("name", "STEVE");
    assert.equal(first.consumed, false);
    assert.equal(first.snapshot?.items[0]?.typeId, "minecraft:diamond");

    const second = await store.consumeEnderSnapshot("name", "steve");
    assert.equal(second.consumed, true);
  });

  it("refuses to overwrite an unconsumed snapshot", async () => {
    await store.saveEnderSnapshot(snapshot("s2", { playerKey: "Alex" }));
    await assert.rejects(store.saveEnderSnapshot(snapshot("s3", { playerKey: "Alex" })), store.SnapshotConflictError);
    assert.equal((await store.loadEnderSnapshot("name", "Alex"))?.snapshotId, "s2");
  });

  it("allows a new save after the previous one was consumed", async () => {
    await store.consumeEnderSnapshot("name", "Alex");
    await store.saveEnderSnapshot(snapshot("s4", { playerKey: "Alex" }));
    const stored = await store.loadEnderSnapshot("name", "Alex");
    assert.equal(stored?.snapshotId, "s4");
    assert.equal(stored?.loadConsumedAt, undefined);
  });

  it("lets the same snapshot be re-saved after consumption (failed-load rollback)", async () => {
    const consumed = await store.consumeEnderSnapshot("name", "Alex");
    assert.ok(consumed.snapshot);
    await store.saveEnderSnapshot({ ...consumed.snapshot, loadConsumedAt: undefined });

    const again = await store.consumeEnderSnapshot("name", "Alex");
    assert.equal(again.consumed, false);
    assert.equal(again.snapshot?.snapshotId, "s4");
  });

  it("keeps a history copy of every save", async () => {
    const dir = path.join(dataDir, "_history", "name", "alex");
    assert.ok((await fs.readdir(dir)).length >= 2);
  });
});
