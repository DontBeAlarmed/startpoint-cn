"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const database = require("../src/data/db")
const questDomain = require("../src/data/domains/quest")

test("quest domain performs one scoped batch query while retaining its return shape", () => {
    const originalGetDb = database.getDb
    let sql = ""
    let parameters
    database.getDb = () => ({
        prepare(statement) {
            sql = statement
            return {
                all(...args) {
                    parameters = args
                    return [{
                        section: 4,
                        quest_id: 40,
                        finished: 1,
                        unlocked: 1,
                        high_score: 10,
                        clear_rank: 5,
                        best_elapsed_time_ms: 123,
                        leader_character_id: 1,
                        multi_clear_count: 2,
                        host_finished: 1,
                    }]
                },
            }
        },
    })

    try {
        const result = questDomain.getPlayerQuestProgressSync(77, [4, 1, 4])
        assert.match(sql, /section IN \(\?, \?\)/)
        assert.deepEqual(parameters, [77, 1, 4])
        assert.deepEqual(result, {
            4: [{
                questId: 40,
                finished: true,
                unlocked: true,
                highScore: 10,
                clearRank: 5,
                bestElapsedTimeMs: 123,
                leaderCharacterId: 1,
                multiClearCount: 2,
                hostFinished: true,
            }],
        })
    } finally {
        database.getDb = originalGetDb
    }
})
