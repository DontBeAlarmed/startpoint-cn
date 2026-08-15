"use strict"

require("ts-node/register/transpile-only")

const { MissionFactLoaderRegistry } = require("../../src/lib/mission")
const { createSession } = require("./mission-evaluation-session-fixture.cjs")

const calls = []
const rejected = name => {
    calls.push(name)
    return Promise.reject(new Error(`${name} expected rejection`))
}
const loaders = new MissionFactLoaderRegistry()
loaders.register("player", () => ({ id: 77 }))
const session = createSession([{ kind: "player" }], loaders, {
    observer: {
        onPlan: () => rejected("onPlan"),
        onLoaderCall: () => rejected("onLoaderCall"),
        onCacheHit: () => rejected("onCacheHit"),
    },
})

session.getFact({ kind: "player" })
session.getFact({ kind: "player" })

setImmediate(() => {
    process.stdout.write(`${calls.join(",")} consumed\n`)
})
