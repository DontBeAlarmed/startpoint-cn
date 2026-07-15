import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertMergedPlayerData } from "../data/validation/merged-player";
import type { MergedPlayerData } from "../data/types";


const databaseDir = mkdtempSync(path.join(tmpdir(), "wf-player-replace-"));
process.env.WF_DATABASE_DIR = databaseDir;

const playerDomain = require("../data/domains/player") as typeof import("../data/domains/player");
const accountDomain = require("../data/domains/account") as typeof import("../data/domains/account");
const characterDomain = require("../data/domains/character") as typeof import("../data/domains/character");
const dataUtils = require("../data/utils") as typeof import("../data/utils");
const { getDb } = require("../data/db") as typeof import("../data/db");

let playerId = 0;
let accountId = 0;
let original: MergedPlayerData;
let canonicalOriginal: unknown;


function clone<T>(value: T): T {
    return structuredClone(value);
}


function canonical(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, child]) => [key, canonical(child)]),
        );
    }
    return value;
}


function read(): MergedPlayerData {
    const value = dataUtils.getMergedPlayerDataSync(playerId);
    assert.ok(value);
    return value;
}


function changed(): MergedPlayerData {
    const value = clone(original);
    value.player.name = "Transactional replacement";
    return value;
}


function firstParty(value: MergedPlayerData) {
    const group = Object.values(value.partyGroupList)[0];
    assert.ok(group);
    const party = Object.values(group.list)[0];
    assert.ok(party);
    return party;
}


function assertOldSaveIntact(): void {
    assert.deepEqual(canonical(read()), canonicalOriginal);
}


before(() => {
    const account = accountDomain.insertAccountSync({
        appId: "transaction-test",
        idpAlias: "test",
        idpCode: "test",
        idpId: "transaction-test",
        status: "active",
    });
    accountId = account.id;
    const player = playerDomain.insertDefaultPlayerSync(accountId);
    playerId = player.id;
    playerDomain.updatePlayerSync({ id: playerId, name: "Original save" });

    const db = getDb();
    let manaNode = db.prepare(`
        SELECT character_id AS characterId, value
        FROM players_characters_mana_nodes
        WHERE player_id = ?
        LIMIT 1
    `).get(playerId) as { characterId: number, value: number } | undefined;
    if (!manaNode) {
        characterDomain.insertPlayerCharacterManaNodesSync(playerId, 1, [999001]);
        manaNode = { characterId: 1, value: 999001 };
    }
    characterDomain.updatePlayerCharacterManaNodeAwakeLevelSync(
        playerId,
        manaNode.characterId,
        manaNode.value,
        2,
    );

    original = read();
    assert.equal(
        original.characterManaNodeAwakeLevels?.[String(manaNode.characterId)]?.[manaNode.value],
        2,
    );
    canonicalOriginal = canonical(original);
});


after(() => {
    getDb().close();
    delete process.env.WF_DATABASE_DIR;
    const resolved = path.resolve(databaseDir);
    const safeBase = path.resolve(tmpdir());
    assert.ok(resolved.startsWith(`${safeBase}${path.sep}`));
    assert.ok(path.basename(resolved).startsWith("wf-player-replace-"));
    rmSync(resolved, { recursive: true, force: true });
});


for (const phase of ["player_children", "characters", "rush_event"] as const) {
    test(`failure at ${phase} rolls back the complete old save`, () => {
        assert.throws(
            () => playerDomain.replacePlayerDataSync(changed(), {
                beforePhase(current) {
                    if (current === phase) throw new Error(`injected-${phase}`);
                },
            }),
            new RegExp(`injected-${phase}`),
        );
        assertOldSaveIntact();
    });
}


test("invalid top-level collection is rejected before delete", () => {
    const invalid = changed() as unknown as Record<string, unknown>;
    invalid.characterList = [];
    assert.throws(
        () => playerDomain.replacePlayerDataSync(invalid as unknown as MergedPlayerData),
        /characterList/,
    );
    assertOldSaveIntact();
});


test("runtime validation rejects identity, shape, duplicates, numbers and dangling references", () => {
    const cases: Array<{ name: string, mutate(value: any): void, pattern: RegExp }> = [
        {
            name: "route player id",
            mutate(value) { value.player.id = playerId + 1; },
            pattern: /player\.id/,
        },
        {
            name: "account id",
            mutate(value) { value.player.accountId = accountId + 1; },
            pattern: /accountId/,
        },
        {
            name: "missing collection",
            mutate(value) { delete value.userOption; },
            pattern: /userOption/,
        },
        {
            name: "array expected",
            mutate(value) { value.dailyChallengePointList = {}; },
            pattern: /dailyChallengePointList/,
        },
        {
            name: "record expected",
            mutate(value) { value.equipmentList = []; },
            pattern: /equipmentList/,
        },
        {
            name: "duplicate numeric id",
            mutate(value) { value.dailyChallengePointList.push(clone(value.dailyChallengePointList[0])); },
            pattern: /duplicate/,
        },
        {
            name: "non-finite number",
            mutate(value) { value.player.stamina = Number.POSITIVE_INFINITY; },
            pattern: /finite/,
        },
        {
            name: "missing character",
            mutate(value) { firstParty(value).characterIds[0] = 99999999; },
            pattern: /characterIds/,
        },
        {
            name: "missing equipment",
            mutate(value) { firstParty(value).equipmentIds[0] = 99999999; },
            pattern: /equipmentIds/,
        },
        {
            name: "missing party",
            mutate(value) { value.player.partySlot = 99999999; },
            pattern: /partySlot/,
        },
    ];

    for (const item of cases) {
        const value: any = changed();
        item.mutate(value);
        assert.throws(
            () => assertMergedPlayerData(value, playerId, accountId),
            item.pattern,
            item.name,
        );
    }
    const plainJson = JSON.parse(JSON.stringify(changed()));
    assert.doesNotThrow(() => assertMergedPlayerData(plainJson, playerId, accountId));
    assertOldSaveIntact();
});


test("client clone round-trip retains mana-node awake levels", () => {
    const serialized = dataUtils.getClientSerializedData(playerId, { viewerId: 0 });
    assert.ok(serialized);
    const deserialized = dataUtils.deserializePlayerData(playerId, serialized);
    assert.deepEqual(
        canonical(deserialized.characterManaNodeAwakeLevels),
        canonical(original.characterManaNodeAwakeLevels),
    );
});


test("legacy snapshot without awake levels preserves matching target nodes", () => {
    const legacy = changed();
    delete legacy.characterManaNodeAwakeLevels;
    playerDomain.replacePlayerDataSync(legacy);
    assert.deepEqual(
        canonical(read().characterManaNodeAwakeLevels),
        canonical(original.characterManaNodeAwakeLevels),
    );
});


test("successful replacement commits and preserves mana-node awake levels", () => {
    const result = playerDomain.replacePlayerDataSync(changed());
    assert.deepEqual(result, { playerId, accountId });
    const restored = read();
    assert.equal(restored.player.name, "Transactional replacement");
    assert.deepEqual(
        canonical(restored.characterManaNodeAwakeLevels),
        canonical(original.characterManaNodeAwakeLevels),
    );
});
