"use strict"

const CHARACTER_ID = 341005
const STALE_CHARACTER_ID = 1
const AWAKE_PROGRESS = Object.freeze([
    [3410051, 1],
    [3410052, 5],
    [3410053, 5],
    [3410054, 3],
])

function summarizeUnlocks(unlocks) {
    return [...unlocks.entries()]
        .map(([characterId, levels]) => [
            Number(characterId),
            Object.entries(levels)
                .map(([boardIndex, awakeLevel]) => [Number(boardIndex), awakeLevel])
                .sort((left, right) => left[0] - right[0]),
        ])
        .sort((left, right) => left[0] - right[0])
}

function summarizeReconciliation(result) {
    return {
        all: summarizeUnlocks(result.all),
        changed: summarizeUnlocks(result.changed),
        removed: summarizeUnlocks(result.removed),
    }
}

function normalizeCharacterList(characterList) {
    return characterList.map(entry => Object.fromEntries(Object.entries(entry)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, value])))
}

function createPlayer(runtime) {
    const account = runtime.insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: "awake-request-context-baseline",
        status: "normal",
    })
    return runtime.insertDefaultPlayerSync(account.id).id
}

function prepareReadyFixture(runtime) {
    const playerId = createPlayer(runtime)
    runtime.insertDefaultPlayerCharacterSync(playerId, CHARACTER_ID)
    const rarity = runtime.getCharacterDataSync(CHARACTER_ID).rarity
    runtime.updatePlayerCharacterSync(playerId, CHARACTER_ID, {
        exp: runtime.characterExpCaps[rarity][0],
    })
    runtime.insertPlayerCharacterManaNodesSync(
        playerId,
        CHARACTER_ID,
        Object.keys(runtime.getCharacterManaNodesSync(CHARACTER_ID, 1)).map(Number),
    )
    for (const [missionId, progress] of AWAKE_PROGRESS) {
        runtime.updatePlayerCategoryMissionSync(playerId, 9, missionId, progress)
    }
    runtime.getDb().prepare(`
        INSERT INTO players_character_quest_clears (
            player_id, character_id, clear_count, multi_count,
            leader_clear_count, leader_multi_count, leader_power_flip_count
        ) VALUES (?, ?, 5, 0, 0, 0, 0)
        ON CONFLICT(player_id, character_id) DO UPDATE SET clear_count = 5
    `).run(playerId, CHARACTER_ID)
    runtime.getDb().prepare(`
        UPDATE players_characters
        SET join_time = ?, update_time = ?
        WHERE player_id = ? AND id = ?
    `).run(runtime.fixedTime, runtime.fixedTime, playerId, CHARACTER_ID)
    runtime.getDb().prepare(`
        DELETE FROM players_character_awake_unlocks WHERE player_id = ?
    `).run(playerId)
    return playerId
}

function prepareFailureFixture(runtime) {
    const playerId = prepareReadyFixture(runtime)
    runtime.upsertPlayerCharacterAwakeUnlockSync(playerId, STALE_CHARACTER_ID, 1, 1)
    runtime.getDb().exec(`
        CREATE TRIGGER fail_awake_request_context_unlock
        BEFORE INSERT ON players_character_awake_unlocks
        BEGIN
            SELECT RAISE(ABORT, 'injected awake unlock write failure');
        END
    `)
    const ownerBefore = runtime.getDb().prepare(`
        SELECT free_mana FROM players WHERE id = ?
    `).pluck().get(playerId)
    return { playerId, ownerBefore }
}

function readFailureBehavior(runtime, fixture) {
    const unlocks = runtime.getPlayerCharacterAwakeUnlocksSync(fixture.playerId)
    const ownerAfter = runtime.getDb().prepare(`
        SELECT free_mana FROM players WHERE id = ?
    `).pluck().get(fixture.playerId)
    return {
        candidateUnlockPresent: unlocks.has(String(CHARACTER_ID)),
        ownerDelta: ownerAfter - fixture.ownerBefore,
        staleUnlockPreserved: unlocks.has(String(STALE_CHARACTER_ID)),
        unlockCount: unlocks.size,
    }
}

function createAwakeRequestContextScenarios(runtime) {
    return [
        {
            name: "full-publication",
            prepare: () => prepareReadyFixture(runtime),
            execute(playerId, measureTarget) {
                return measureTarget(() => (
                    runtime.reconcileAwakeUnlockCharacterListStrict(playerId, [{
                        character_id: CHARACTER_ID,
                        owner_projection: true,
                        mana_board_awake: { 2: 2 },
                    }])
                ))
            },
            summarize(characterList, playerId) {
                const category9Progress = runtime.getDb().prepare(`
                    SELECT id, progress FROM players_category_missions
                    WHERE player_id = ? AND category = 9 ORDER BY id
                `).all(playerId).map(row => [row.id, row.progress])
                const manaNodeCount = runtime.getDb().prepare(`
                    SELECT COUNT(*) FROM players_characters_mana_nodes
                    WHERE player_id = ? AND character_id = ?
                `).pluck().get(playerId, CHARACTER_ID)
                return {
                    category9Progress,
                    characterList: normalizeCharacterList(characterList),
                    manaNodeCount,
                    persistedUnlocks: summarizeUnlocks(
                        runtime.getPlayerCharacterAwakeUnlocksSync(playerId),
                    ),
                }
            },
        },
        {
            name: "candidate-one",
            prepare: () => prepareReadyFixture(runtime),
            execute(playerId, measureTarget) {
                return measureTarget(() => ({
                    first: runtime.reconcileAwakeUnlocks(playerId, [CHARACTER_ID]),
                    second: runtime.reconcileAwakeUnlocks(playerId, [CHARACTER_ID]),
                }))
            },
            summarize(result, playerId) {
                return {
                    first: summarizeReconciliation(result.first),
                    second: summarizeReconciliation(result.second),
                    finalUnlocks: summarizeUnlocks(
                        runtime.getPlayerCharacterAwakeUnlocksSync(playerId),
                    ),
                }
            },
        },
        {
            name: "empty-candidate-cleanup",
            prepare() {
                const playerId = prepareReadyFixture(runtime)
                runtime.upsertPlayerCharacterAwakeUnlockSync(playerId, CHARACTER_ID, 1, 1)
                runtime.updatePlayerCharacterSync(playerId, CHARACTER_ID, { exp: 0 })
                return playerId
            },
            execute: (playerId, measureTarget) => (
                measureTarget(() => runtime.reconcileAwakeUnlocks(playerId, []))
            ),
            summarize(result, playerId) {
                return {
                    ...summarizeReconciliation(result),
                    finalUnlocks: summarizeUnlocks(
                        runtime.getPlayerCharacterAwakeUnlocksSync(playerId),
                    ),
                }
            },
        },
        {
            name: "strict-failure-rollback",
            prepare: () => prepareFailureFixture(runtime),
            execute(fixture, measureTarget) {
                let threw = false
                try {
                    runtime.getDb().transaction(() => {
                        runtime.getDb().prepare(`
                            UPDATE players SET free_mana = free_mana + 7 WHERE id = ?
                        `).run(fixture.playerId)
                        measureTarget(() => (
                            runtime.reconcileAwakeUnlockCharacterListStrict(fixture.playerId, [])
                        ))
                    })()
                } catch {
                    threw = true
                }
                return { fixture, threw }
            },
            summarize({ fixture, threw }) {
                return {
                    ...readFailureBehavior(runtime, fixture),
                    errorCategory: threw ? "database-write-failure" : "none",
                    threw,
                }
            },
        },
        {
            name: "best-effort-failure",
            prepare: () => prepareFailureFixture(runtime),
            execute(fixture, measureTarget) {
                const existing = [{ character_id: CHARACTER_ID, owner_projection: true }]
                let returned
                let errorLogged = false
                const previousError = console.error
                console.error = () => { errorLogged = true }
                try {
                    runtime.getDb().transaction(() => {
                        runtime.getDb().prepare(`
                            UPDATE players SET free_mana = free_mana + 7 WHERE id = ?
                        `).run(fixture.playerId)
                        returned = measureTarget(() => (
                            runtime.reconcileAwakeUnlockCharacterListBestEffort(
                                fixture.playerId,
                                existing,
                            )
                        ))
                    })()
                } finally {
                    console.error = previousError
                }
                return {
                    errorLogged,
                    fixture,
                    returnedExistingIdentity: returned === existing,
                }
            },
            summarize({ errorLogged, fixture, returnedExistingIdentity }) {
                return {
                    ...readFailureBehavior(runtime, fixture),
                    errorLogged,
                    returnedExistingIdentity,
                }
            },
        },
    ]
}

module.exports = { createAwakeRequestContextScenarios }
