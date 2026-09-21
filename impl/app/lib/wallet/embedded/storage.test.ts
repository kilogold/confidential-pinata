import assert from "node:assert/strict";
import { test } from "node:test";
import { loadOrCreateEmbeddedSigner, type SeedStore } from "./storage";

function memoryStore(): SeedStore {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

test("GM and Player seeds persist independently across reloads", async () => {
  const store = memoryStore();
  const gm = await loadOrCreateEmbeddedSigner("gm", store);
  const player = await loadOrCreateEmbeddedSigner("player", store);
  const gmAfterReload = await loadOrCreateEmbeddedSigner("gm", store);
  const playerAfterReload = await loadOrCreateEmbeddedSigner("player", store);

  assert.notEqual(gm.address, player.address);
  assert.equal(gmAfterReload.address, gm.address);
  assert.equal(playerAfterReload.address, player.address);
  assert.match(store.getItem("pinata:embedded:gm:seed")!, /^[0-9a-f]{64}$/);
  assert.match(store.getItem("pinata:embedded:player:seed")!, /^[0-9a-f]{64}$/);
  assert.equal(gm.keyPair.privateKey.extractable, false);
});

test("a storage read failure never creates a replacement identity", async () => {
  let writes = 0;
  const store: SeedStore = {
    getItem: () => {
      throw new Error("storage blocked");
    },
    setItem: () => {
      writes += 1;
    },
  };

  await assert.rejects(
    loadOrCreateEmbeddedSigner("gm", store),
    /Local GM identity storage failed: storage blocked/
  );
  assert.equal(writes, 0);
});

test("an invalid stored seed is not replaced", async () => {
  let writes = 0;
  const store: SeedStore = {
    getItem: () => "not a seed",
    setItem: () => {
      writes += 1;
    },
  };

  await assert.rejects(
    loadOrCreateEmbeddedSigner("player", store),
    /invalid stored key/
  );
  assert.equal(writes, 0);
});

test("a storage write failure does not return a new identity", async () => {
  const store: SeedStore = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota exceeded");
    },
  };

  await assert.rejects(
    loadOrCreateEmbeddedSigner("gm", store),
    /Local GM identity storage failed: quota exceeded/
  );
});

test("concurrent calls in one tab reuse the stored identity", async () => {
  const store = memoryStore();
  const [first, second] = await Promise.all([
    loadOrCreateEmbeddedSigner("gm", store),
    loadOrCreateEmbeddedSigner("gm", store),
  ]);
  assert.equal(first.address, second.address);
});
