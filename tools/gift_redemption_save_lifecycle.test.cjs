"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gift-save-lifecycle-"))
process.env.DATA_DIR = databaseDirectory

require("ts-node/register/transpile-only")

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    PLAYER_SAVE_EXCLUDED_TABLES,
    PLAYER_SAVE_TABLES,
    applyPlayerSaveTemplateSync,
    clonePlayerSaveV2Sync,
    clearGiftRedemptionsForExternalRestoreSync,
    copyGiftRedemptionsForCloneSync,
    exportPlayerSaveV2Sync,
    restorePlayerSaveSnapshotSync,
    restorePlayerSaveV2Sync,
    validatePlayerSaveTemplateSync,
} = require("../src/data/player-save")

let db
let nextGiftId = 1001

function createAccount(label) {
    return insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `gift-save-${label}-${Math.random().toString(36).slice(2)}`,
        status: "normal",
    })
}

function addRedemption(playerId, inheritedFrom = null, rewardRevision = 1) {
    const giftId = nextGiftId++
    db.transaction(() => {
        db.prepare(`
            INSERT INTO server_gift_codes (id, code, status, reward_revision, created_at, updated_at)
            VALUES (?, ?, 'active', 1, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')
        `).run(giftId, `gift-save-${giftId}`)
        db.prepare(`
            INSERT INTO players_gift_redemptions (
                gift_id, player_id, reward_revision, reward_snapshot,
                redeemed_at, inherited_from_player_id
            ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            giftId,
            playerId,
            rewardRevision,
            JSON.stringify([{ position: 0, type_id: 30005, number: rewardRevision }]),
            "2026-08-30T00:01:00.000Z",
            inheritedFrom,
        )
    })()
    return giftId
}

function addLoginBonus(playerId, groupId, grantedIndex, receivedAt) {
    db.prepare(`
        INSERT INTO players_login_bonus_progress (
            player_id, group_id, last_granted_index,
            last_granted_business_day, received_at, shown_at
        ) VALUES (?, ?, ?, '2026-08-30', ?, NULL)
    `).run(playerId, groupId, grantedIndex, receivedAt)
}

function redemptionRows(playerId) {
    return db.prepare(`
        SELECT gift_id, player_id, reward_revision, reward_snapshot,
               redeemed_at, inherited_from_player_id
        FROM players_gift_redemptions
        WHERE player_id = ?
        ORDER BY gift_id
    `).all(playerId)
}

function duplicateOptionInSnapshot(snapshot) {
    const rows = snapshot.domains.core.tables.players_options
    snapshot.domains.core.tables.players_options = [...rows, { ...rows[0] }]
    return snapshot
}

function getMergedPlayerData(playerId) {
    const { getMergedPlayerDataSync } = require("../src/data/utils/player-data")
    return getMergedPlayerDataSync(playerId)
}

test.before(() => {
    db = data.initializeDatabase()
})

test.after(() => {
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

test("same-player redemption stays available and registry marks it as a server operation", () => {
    assert.equal(
        PLAYER_SAVE_TABLES.some(table => table.name === "players_gift_redemptions"),
        false,
    )
    assert.deepEqual(
        PLAYER_SAVE_EXCLUDED_TABLES.find(table => table.name === "players_gift_redemptions"),
        { name: "players_gift_redemptions", reason: "serverOperation" },
    )

    const playerId = insertDefaultPlayerSync(createAccount("same").id).id
    const giftId = addRedemption(playerId)
    assert.equal(giftId > 0, true)
    assert.deepEqual(redemptionRows(playerId), [{
        gift_id: giftId,
        player_id: playerId,
        reward_revision: 1,
        reward_snapshot: JSON.stringify([{ position: 0, type_id: 30005, number: 1 }]),
        redeemed_at: "2026-08-30T00:01:00.000Z",
        inherited_from_player_id: null,
    }])
})

test("same-server clone copies redemptions inside the outer clone transaction", () => {
    const sourceId = insertDefaultPlayerSync(createAccount("clone-source").id).id
    const destinationAccount = createAccount("clone-target")
    const originalGiftId = addRedemption(sourceId, null, 2)
    const sourceSnapshot = exportPlayerSaveV2Sync(sourceId)
    const cloneResult = db.transaction(() => clonePlayerSaveV2Sync(sourceSnapshot, destinationAccount.id, db))()
    const rows = redemptionRows(cloneResult.playerId)

    assert.equal(rows.length, 1)
    assert.equal(rows[0].gift_id, originalGiftId)
    assert.deepEqual(rows[0], {
        gift_id: rows[0].gift_id,
        player_id: cloneResult.playerId,
        reward_revision: 2,
        reward_snapshot: JSON.stringify([{ position: 0, type_id: 30005, number: 2 }]),
        redeemed_at: "2026-08-30T00:01:00.000Z",
        inherited_from_player_id: sourceId,
    })
})

test("new and template-created players retain no redemption state", () => {
    const sourceId = insertDefaultPlayerSync(createAccount("template-source").id).id
    addRedemption(sourceId)
    const templateAccountId = createAccount("template-target").id
    const targetId = insertDefaultPlayerSync(templateAccountId).id
    addRedemption(targetId)

    applyPlayerSaveTemplateSync(exportPlayerSaveV2Sync(sourceId), targetId, db)

    assert.equal(redemptionRows(targetId).length, 0)
    const emptyId = insertDefaultPlayerSync(createAccount("template-empty").id).id
    assert.equal(redemptionRows(emptyId).length, 0)
})

test("v2 export contains no redemption table or data", () => {
    const playerId = insertDefaultPlayerSync(createAccount("export").id).id
    addRedemption(playerId)

    const snapshot = exportPlayerSaveV2Sync(playerId)
    const tables = Object.values(snapshot.domains).flatMap(domain => Object.keys(domain.tables))

    assert.equal(snapshot.formatVersion, 2)
    assert.equal(tables.includes("players_gift_redemptions"), false)
    assert.equal(JSON.stringify(snapshot).includes("players_gift_redemptions"), false)
})

test("v2 restore clears prior redemptions and rolls them back when insertion fails", () => {
    const sourceId = insertDefaultPlayerSync(createAccount("v2-source").id).id
    const targetId = insertDefaultPlayerSync(createAccount("v2-target").id).id
    addRedemption(sourceId)
    addRedemption(targetId)
    const original = redemptionRows(targetId)
    const invalid = duplicateOptionInSnapshot(exportPlayerSaveV2Sync(sourceId))

    assert.throws(() => restorePlayerSaveV2Sync(invalid, targetId, db), /unique constraint/i)
    assert.deepEqual(redemptionRows(targetId), original)
})

test("legacy restore clears prior redemptions inside its restore transaction", () => {
    const sourceId = insertDefaultPlayerSync(createAccount("legacy-source").id).id
    const targetId = insertDefaultPlayerSync(createAccount("legacy-target").id).id
    const { getMergedPlayerDataSync } = require("../src/data/utils/player-data")
    addRedemption(sourceId)
    addRedemption(targetId)
    const legacy = getMergedPlayerDataSync(sourceId)
    legacy.player.name = "legacy-gift-target"

    assert.equal(
        restorePlayerSaveSnapshotSync({
            schema: "starpoint-cn-save",
            version: 1,
            playerId: sourceId,
            data: legacy,
        }, targetId, db).legacyPartial,
        true,
    )
    assert.equal(redemptionRows(targetId).length, 0)
})

test("failed legacy import after clearing rolls back the original redemption", () => {
    const sourceId = insertDefaultPlayerSync(createAccount("legacy-fail-source").id).id
    const targetId = insertDefaultPlayerSync(createAccount("legacy-fail-target").id).id
    const { getMergedPlayerDataSync } = require("../src/data/utils/player-data")
    addLoginBonus(sourceId, "gift-rollback", 1, 1000)
    addLoginBonus(targetId, "gift-rollback", 2, 2000)
    addRedemption(targetId)
    const original = redemptionRows(targetId)
    const legacy = getMergedPlayerDataSync(sourceId)

    db.prepare(`
        CREATE TRIGGER fail_preserved_login_bonus_insert
        BEFORE INSERT ON players_login_bonus_progress
        WHEN NEW.group_id = 'gift-rollback'
        BEGIN
            SELECT RAISE(ABORT, 'injected preserved insert failure');
        END
    `).run()
    assert.throws(
        () => restorePlayerSaveSnapshotSync({
            schema: "starpoint-cn-save",
            version: 1,
            playerId: sourceId,
            data: legacy,
        }, targetId, db),
        /injected preserved insert failure/,
    )
    db.prepare("DROP TRIGGER fail_preserved_login_bonus_insert").run()
    assert.deepEqual(redemptionRows(targetId), original)
})

test("failed real clone through the public API rolls the whole target back", () => {
    const sourceId = insertDefaultPlayerSync(createAccount("clone-fail-source").id).id
    const destinationAccount = createAccount("clone-fail-target")
    addRedemption(sourceId, null, 3)
    const snapshot = exportPlayerSaveV2Sync(sourceId)

    const targetId = insertDefaultPlayerSync(destinationAccount.id).id
    addRedemption(targetId, null, 4)
    const targetBefore = redemptionRows(targetId)
    const playersBefore = db.prepare("SELECT COUNT(*) AS count FROM players").get().count
    const redemptionsBefore = db.prepare("SELECT COUNT(*) AS count FROM players_gift_redemptions").get().count

    db.prepare(`
        CREATE TRIGGER fail_inherited_gift_clone
        BEFORE INSERT ON players_gift_redemptions
        WHEN NEW.inherited_from_player_id IS NOT NULL
             AND NEW.player_id <> NEW.inherited_from_player_id
        BEGIN
            SELECT RAISE(ABORT, 'inherited gift clone failure');
        END
    `).run()
    assert.throws(
        () => clonePlayerSaveV2Sync(snapshot, destinationAccount.id, db),
        /inherited gift clone failure/,
    )
    db.prepare("DROP TRIGGER fail_inherited_gift_clone").run()

    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players").get().count, playersBefore)
    assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM players_gift_redemptions").get().count,
        redemptionsBefore,
    )
    assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM players WHERE account_id = ?").get(destinationAccount.id).count,
        1,
    )
    assert.deepEqual(redemptionRows(targetId), targetBefore)
    assert.equal(redemptionRows(sourceId).length, 1)
})

test("public save mutations reject a non-canonical database before changing rows", () => {
    const sourceId = insertDefaultPlayerSync(createAccount("canonical-source").id).id
    const targetId = insertDefaultPlayerSync(createAccount("canonical-target").id).id
    const templateAccountId = createAccount("canonical-template").id
    const snapshot = exportPlayerSaveV2Sync(sourceId)
    const legacy = getMergedPlayerData(sourceId)
    const nonCanonical = Object.create(db)
    const playersBefore = db.prepare("SELECT COUNT(*) AS count FROM players").get().count
    const accountsBefore = db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count

    assert.throws(
        () => clonePlayerSaveV2Sync(snapshot, templateAccountId, nonCanonical),
        /canonical database connection/,
    )
    assert.throws(
        () => restorePlayerSaveV2Sync(snapshot, targetId, nonCanonical),
        /canonical database connection/,
    )
    assert.throws(
        () => restorePlayerSaveSnapshotSync({
            schema: "starpoint-cn-save",
            version: 1,
            playerId: sourceId,
            data: legacy,
        }, targetId, nonCanonical),
        /canonical database connection/,
    )
    assert.throws(
        () => applyPlayerSaveTemplateSync(snapshot, targetId, nonCanonical),
        /canonical database connection/,
    )
    assert.throws(
        () => validatePlayerSaveTemplateSync(snapshot, nonCanonical),
        /canonical database connection/,
    )

    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM players").get().count, playersBefore)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count, accountsBefore)
})

test("external restore helper clears only the requested player's redemptions", () => {
    const playerId = insertDefaultPlayerSync(createAccount("clear-one").id).id
    const otherId = insertDefaultPlayerSync(createAccount("clear-other").id).id
    addRedemption(playerId)
    addRedemption(otherId)

    assert.equal(clearGiftRedemptionsForExternalRestoreSync(playerId), 1)
    assert.equal(redemptionRows(playerId).length, 0)
    assert.equal(redemptionRows(otherId).length, 1)
})

test("deleting a player cascades its redemption without affecting another player", () => {
    const playerId = insertDefaultPlayerSync(createAccount("cascade-delete").id).id
    const otherId = insertDefaultPlayerSync(createAccount("cascade-other").id).id
    addRedemption(playerId)
    addRedemption(otherId)

    db.prepare("DELETE FROM players WHERE id = ?").run(playerId)

    assert.equal(redemptionRows(playerId).length, 0)
    assert.equal(redemptionRows(otherId).length, 1)
})
