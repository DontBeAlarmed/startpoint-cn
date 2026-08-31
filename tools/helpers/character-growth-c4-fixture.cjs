"use strict"

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { randomUUID } = require("node:crypto")

require("ts-node/register/transpile-only")

const { installBundledGameplaySnapshot } = require("./install-bundled-gameplay-snapshot.cjs")

function createCharacterGrowthC4Fixture() {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "character-growth-c4-"))
    const previousDataDirectory = process.env.DATA_DIR
    process.env.DATA_DIR = dataDirectory
    const restoreContentSnapshot = installBundledGameplaySnapshot()

    const { initializeDatabase } = require("../../src/data")
    const { insertAccountSync } = require("../../src/data/domains/account")
    const {
        getPlayerCharacterSync,
        insertDefaultPlayerCharacterSync,
        updatePlayerCharacterSync,
    } = require("../../src/data/domains/character")
    const { getPlayerItemSync, givePlayerItemSync } = require("../../src/data/domains/item")
    const { getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } = require("../../src/data/domains/player")
    const { insertSessionWithToken } = require("../../src/data/domains/session")
    const { SessionType } = require("../../src/data/types")
    const db = initializeDatabase()
    let sequence = 0

    function createPlayer() {
        sequence += 1
        const account = insertAccountSync({
            appId: "wf_cn",
            idpAlias: "",
            idpCode: "c4-test",
            idpId: `character-growth-c4-${sequence}-${randomUUID()}`,
            status: "normal",
        })
        const player = insertDefaultPlayerSync(account.id)
        return player.id
    }

    function addCharacter(playerId, characterId, patch = {}) {
        if (getPlayerCharacterSync(playerId, characterId) === null) {
            insertDefaultPlayerCharacterSync(playerId, characterId)
        }
        if (Object.keys(patch).length > 0) updatePlayerCharacterSync(playerId, characterId, patch)
        return getPlayerCharacterSync(playerId, characterId)
    }

    function setPlayer(playerId, patch) {
        updatePlayerSync({ id: playerId, ...patch })
        return getPlayerSync(playerId)
    }

    function item(playerId, itemId) {
        return getPlayerItemSync(playerId, itemId)
    }

    function giveItem(playerId, itemId, amount) {
        return givePlayerItemSync(playerId, itemId, amount)
    }

    async function createViewer(playerId, viewerId) {
        const accountId = db.prepare("SELECT account_id FROM players WHERE id = ?").get(playerId).account_id
        await insertSessionWithToken({
            token: String(viewerId),
            accountId,
            expires: new Date("2099-01-01T00:00:00.000Z"),
            type: SessionType.VIEWER,
        })
        return viewerId
    }

    function cleanup() {
        if (db.open) db.close()
        restoreContentSnapshot()
        fs.rmSync(dataDirectory, { recursive: true, force: true })
        if (previousDataDirectory === undefined) delete process.env.DATA_DIR
        else process.env.DATA_DIR = previousDataDirectory
    }

    return { db, createPlayer, addCharacter, setPlayer, item, giveItem, createViewer, cleanup }
}

module.exports = { createCharacterGrowthC4Fixture }
