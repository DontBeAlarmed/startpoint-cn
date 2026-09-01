"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    AWAKE_CHARACTER_ID,
    AWAKE_MANA_THRESHOLD,
    closeAwakeOwnerFactPublicationFixture,
    createAwakeOwnerFactPublicationFixture,
} = require("./helpers/awake-owner-fact-publication-fixture.cjs")
const {
    publishCharacterGrowthOwnerStateBestEffort,
} = require("../src/lib/character-growth/owner-publication")

let fixture

test.before(async () => {
    fixture = await createAwakeOwnerFactPublicationFixture()
})

test.after(async () => {
    await closeAwakeOwnerFactPublicationFixture(fixture)
})

test("in-transaction Growth publication failure rolls back the caller transaction", async () => {
    const { playerId } = await fixture.createPlayer("growth-owner-transaction")
    fixture.prepareForManaUnlock(playerId, AWAKE_MANA_THRESHOLD)
    const before = fixture.playerDomain.getPlayerSync(playerId)
    assert.ok(before)

    fixture.database.exec(`
        CREATE TRIGGER growth_owner_publication_failure
        BEFORE INSERT ON players_character_awake_unlocks
        WHEN NEW.player_id = ${playerId} AND NEW.character_id = ${AWAKE_CHARACTER_ID}
        BEGIN SELECT RAISE(ABORT, 'injected growth owner publication failure'); END;
    `)

    const errors = []
    const originalConsoleError = console.error
    console.error = (...args) => errors.push(args)
    try {
        assert.throws(
            () => fixture.database.transaction(() => {
                fixture.playerDomain.updatePlayerSync({
                    id: playerId,
                    totalManaObtained: before.totalManaObtained + 1,
                })
                publishCharacterGrowthOwnerStateBestEffort(
                    playerId,
                    [AWAKE_CHARACTER_ID],
                    [[]],
                    { invalidatedFactKeys: [{ kind: "player" }] },
                    "growth-owner-transaction",
                    new Date("2024-08-14T12:00:00.000Z"),
                )
            })(),
            /injected growth owner publication failure/,
        )
    } finally {
        console.error = originalConsoleError
    }

    assert.deepEqual(
        fixture.playerDomain.getPlayerSync(playerId).totalManaObtained,
        before.totalManaObtained,
    )
    assert.deepEqual(fixture.awakeUnlock(playerId) ?? {}, {})
    assert.equal(errors.length, 0)
})

test("in-transaction Growth context failure rolls back the caller transaction", async () => {
    const { playerId } = await fixture.createPlayer("growth-owner-context-transaction")
    const before = fixture.playerDomain.getPlayerSync(playerId)
    assert.ok(before)

    const errors = []
    const originalConsoleError = console.error
    console.error = (...args) => errors.push(args)
    try {
        assert.throws(
            () => fixture.database.transaction(() => {
                fixture.playerDomain.updatePlayerSync({
                    id: playerId,
                    totalManaObtained: before.totalManaObtained + 1,
                })
                publishCharacterGrowthOwnerStateBestEffort(
                    playerId,
                    [],
                    [[]],
                    { directMissionIds: [-1] },
                    "growth-owner-context-transaction",
                    new Date("2024-08-14T12:00:00.000Z"),
                )
            })(),
            /Awake direct mission IDs must be positive safe integers/,
        )
    } finally {
        console.error = originalConsoleError
    }

    assert.equal(
        fixture.playerDomain.getPlayerSync(playerId).totalManaObtained,
        before.totalManaObtained,
    )
    assert.equal(errors.length, 0)
})
