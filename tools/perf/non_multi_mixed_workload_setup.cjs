"use strict"

const { seedNonMultiMixedFixture } = require("./non_multi_mixed_fixture.cjs")
const {
    createNonMultiMixedWriteContext,
} = require("./non_multi_mixed_write_fixture.cjs")

function inspectAuthIdentity(runtime, identity) {
    const db = runtime.getDb()
    return {
        binding: db.prepare(`
            SELECT device_id, account_id FROM device_bindings WHERE device_id = ?
        `).get(identity.deviceId),
        viewerSessions: db.prepare(`
            SELECT token, account_id, type FROM sessions
            WHERE account_id = ? AND type = ? ORDER BY token
        `).all(identity.accountId, runtime.SessionType.VIEWER),
    }
}

function prepareSeed(runtime, scenarioDependencies, seedDirectory, profile) {
    const paths = runtime.resolveRuntimeDataPaths({ DATA_DIR: seedDirectory })
    runtime.initializeDatabase({ paths })
    const pool = seedNonMultiMixedFixture(runtime, profile)
    const db = runtime.getDb()
    const writeContext = createNonMultiMixedWriteContext(db, {
        insertMail: runtime.insertMailSync,
    })
    const mailFixtureByIdentity = {}
    for (const identity of pool.activeIdentities) {
        if (identity.entryName === "single-battle") {
            scenarioDependencies.prepareSingleBattleIdentity(db, identity)
        }
        if (identity.entryName === "shop") writeContext.prepareShopIdentity(identity)
        if (identity.entryName === "gacha") writeContext.prepareGachaIdentity(identity)
        if (identity.entryName === "mail") {
            const fixture = writeContext.prepareMailIdentity(identity)
            mailFixtureByIdentity[identity.playerId] = fixture
        }
    }
    runtime.checkpointDatabase()
    runtime.closeDatabase()
    return { pool, mailFixtureByIdentity }
}

function createStepContext(runtime, mailFixtureByIdentity, identities) {
    return {
        skipPrepare: true,
        inspectAuthIdentity: identity => inspectAuthIdentity(runtime, identity),
        ...createNonMultiMixedWriteContext(runtime.getDb(), {
            insertMail: runtime.insertMailSync,
        }),
        mailFixtureByIdentity,
        singleBattlePeer: identities.find(identity => identity.entryName === "auth"),
    }
}

module.exports = { createStepContext, prepareSeed }
