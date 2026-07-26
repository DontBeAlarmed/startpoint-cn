require("ts-node/register/transpile-only")

delete process.env.WDFP_DATABASE_DIR

const { closeDatabase, initializeDatabase } = require("../../src/data")
const { recordEventLoginMissionFactSync } = require("../../src/lib/mission/event-entry-facts")

initializeDatabase()
process.send("ready")
process.once("message", message => {
    if (message !== "go") return
    try {
        const result = recordEventLoginMissionFactSync(
            Number(process.env.PLAYER_ID),
            new Date(process.env.EVALUATION_TIME),
        )
        process.send({ result })
    } catch (error) {
        process.send({ error: error instanceof Error ? error.message : String(error) })
    } finally {
        closeDatabase()
    }
})
