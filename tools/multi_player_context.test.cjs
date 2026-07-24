const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
require("ts-node/register/transpile-only")

const { resolveIsRoomHost } = require("../src/lib/quest/host-finish")

assert.equal(resolveIsRoomHost({
    roomHostPlayerId: null,
    playerId: 17,
}), undefined, "缺失房间时房主身份必须保持未知")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

stubModule("../src/data/activeAccount", { resolvePlayerIdSync: () => null })
stubModule("../src/data/domains/player", { getPlayerSync: () => null })
stubModule("../src/data/domains/session", { getSession: async () => null })

let multiPlayerContext = {}
try {
    multiPlayerContext = require("../src/multi/player-context")
} catch {
    // The RED run intentionally reaches this branch before the shared resolver exists.
}

assert.equal(typeof multiPlayerContext.resolveMultiPlayerContext, "function")

async function testActivePlayerWinsOverFirstAccountPlayer() {
    const accountId = 11
    const playerIds = [16, 17, 18]
    const defaultPlayers = { 11: 18 }
    const activePlayerId = defaultPlayers[accountId]

    assert.equal(playerIds[0], 16)
    assert.equal(resolveIsRoomHost({
        roomHostPlayerId: playerIds[0],
        playerId: activePlayerId,
    }), false)

    const calls = []
    const player18 = { id: 18, name: "active-save" }
    const context = await multiPlayerContext.resolveMultiPlayerContext(800000011, {
        getSession: async viewerId => {
            calls.push(["session", viewerId])
            return { accountId }
        },
        resolvePlayerIdSync: resolvedAccountId => {
            calls.push(["resolve", resolvedAccountId])
            return defaultPlayers[resolvedAccountId] ?? playerIds[0]
        },
        getPlayerSync: playerId => {
            calls.push(["player", playerId])
            return playerId === 18 ? player18 : null
        },
    })

    assert.deepEqual(context, { playerId: 18, player: player18 })
    assert.deepEqual(calls, [
        ["session", "800000011"],
        ["resolve", 11],
        ["player", 18],
    ])
    assert.equal(resolveIsRoomHost({
        roomHostPlayerId: context.playerId,
        playerId: activePlayerId,
    }), true)
}

function testMultiEntrypointsSharePlayerContextResolver() {
    const root = path.resolve(__dirname, "..")
    const entrypoints = [
        "src/multi/http/lobby.ts",
        "src/multi/tcp/handshake.ts",
        "src/multi/http/battle.ts",
    ]

    for (const relativePath of entrypoints) {
        const source = fs.readFileSync(path.join(root, relativePath), "utf8")
        assert.match(source, /resolveMultiPlayerContext\s*\(/, `${relativePath} must use the shared resolver`)
    }

    const multiRoot = path.join(root, "src/multi")
    const sourceFiles = []
    const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name)
            if (entry.isDirectory()) visit(entryPath)
            else if (entry.isFile() && entry.name.endsWith(".ts")) sourceFiles.push(entryPath)
        }
    }
    visit(multiRoot)

    for (const sourceFile of sourceFiles) {
        const source = fs.readFileSync(sourceFile, "utf8")
        assert.doesNotMatch(
            source,
            /\b(?:players|playerIds)\s*\[\s*0\s*\]/,
            `${path.relative(root, sourceFile)} must not derive identity from the first account player`,
        )
    }
}

async function main() {
    await testActivePlayerWinsOverFirstAccountPlayer()
    testMultiEntrypointsSharePlayerContextResolver()
    console.log("multi player context tests passed")
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
