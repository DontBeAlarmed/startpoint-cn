const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

require("ts-node/register/transpile-only")

function stubModule(relativePath, exports) {
    const modulePath = require.resolve(relativePath)
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    }
}

stubModule("../src/multi/player-context", {
    getPlayerRankLevel: () => 1,
    resolveMultiPlayerContext: () => { throw new Error("handshake must not resolve player context") },
})
stubModule("../src/data/domains/party", {
    getPlayerPartyGroupListSync: () => ({}),
})
stubModule("../src/data/domains/character", {
    getPlayerCharacterManaNodesSync: () => [],
    getPlayerCharacterSync: () => null,
})
stubModule("../src/data/domains/equipment", {
    getPlayerEquipmentSync: () => null,
})

const { sessionManager } = require("../src/multi/state/SessionManager")
const { createRoom, disbandRoom } = require("../src/multi/room/manager")
const { handleHandshake } = require("../src/multi/tcp/handshake")

class FakeSocket extends EventEmitter {
    constructor() {
        super()
        this.writable = true
    }
    write() { return true }
    end() { this.writable = false }
}

async function captureConsole(callback) {
    const entries = []
    const originals = {}
    for (const method of ["log", "warn", "error"]) {
        originals[method] = console[method]
        console[method] = (...args) => entries.push(args.map(value => {
            if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack || ""}`
            return typeof value === "string" ? value : JSON.stringify(value)
        }).join(" "))
    }
    try {
        await callback()
    } finally {
        for (const method of ["log", "warn", "error"]) console[method] = originals[method]
    }
    return entries.join("\n")
}

function multiTypeScriptFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const entryPath = path.join(directory, entry.name)
        if (entry.isDirectory()) return multiTypeScriptFiles(entryPath)
        return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : []
    })
}

test("room handshake checks the lifecycle guard after admission consumption", async t => {
    const socket = new FakeSocket()
    const room = createRoom(93, 193, 1, 1, 293, 0, 393)
    t.after(() => disbandRoom(room.room_number))
    let lifecycleChecks = 0
    const admission = {
        roomNumber: room.room_number,
        participant: { nodeSessionId: "embedded", viewerId: 93 },
        snapshot: {
            viewerId: 93,
            name: "late-player",
            rank: 1,
            degreeId: 1,
            mainCharacterId: 393,
            playerRoleKind: 1,
            isNewbie: false,
            currentPartyId: 1,
            party: {},
            npcParties: [],
        },
        expiresAt: 6_000,
    }
    const handshake = handleHandshake(
        socket,
        {
            socklet: "cooperation_room",
            viewerId: 93,
            room_number: room.room_number,
            questCategory: room.category,
            questId: room.quest_id,
        },
        { generation: 7, isAccepting: () => ++lifecycleChecks === 1 },
        { admissionProvider: { consume: () => admission } },
    )
    await handshake

    assert.equal(sessionManager.getUniqueRoomClientByViewerId(93, room.room_number), undefined)
    assert.equal(sessionManager.isRoomHostParticipant(room.room_number, {
        nodeSessionId: "embedded",
        viewerId: 93,
    }), false)
})

test("battle handshake refuses registration when its lifecycle generation is inactive", async () => {
    const socket = new FakeSocket()
    await handleHandshake(
        socket,
        { socklet: "cooperation_battle", room_number: "guard-battle", connection_id: "guard-cid" },
        { generation: 8, isAccepting: () => false },
    )

    assert.equal(sessionManager.getBattleClient("guard-cid"), undefined)
})

test("handshake logs never serialize client identity or payload fields", async () => {
    const socket = new FakeSocket()
    socket.remoteAddress = "203.0.113.201"
    socket.remotePort = 61981
    const sentinels = [
        "918273641",
        "NODE_SESSION_SENTINEL_HANDSHAKE",
        "CONNECTION_SENTINEL_HANDSHAKE",
        "203.0.113.201",
        "61981",
        "ROOM_PAYLOAD_SENTINEL_HANDSHAKE",
        "TOKEN_SENTINEL_HANDSHAKE",
    ]

    const output = await captureConsole(() => handleHandshake(socket, {
        socklet: "unsupported_handshake",
        viewerId: 918273641,
        nodeSessionId: "NODE_SESSION_SENTINEL_HANDSHAKE",
        connection_id: "CONNECTION_SENTINEL_HANDSHAKE",
        room_number: "ROOM_PAYLOAD_SENTINEL_HANDSHAKE",
        access_token: "TOKEN_SENTINEL_HANDSHAKE",
    }))

    for (const sentinel of sentinels) assert.doesNotMatch(output, new RegExp(sentinel))
    assert.match(output, /\[TCP\] handshake received/)
})

test("multiplayer console calls reject sensitive identifiers and raw errors", () => {
    const multiRoot = path.resolve(__dirname, "../src/multi")
    const forbiddenIdentifiers = new Set([
        "viewerId", "viewer_id", "hostViewerId", "playerId", "player_id",
        "nodeSessionId", "node_session_id", "connectionId", "connection_id",
        "remoteAddress", "remotePort", "accessToken", "access_token",
        "token", "tokenDigest", "digest", "credential", "sessionCredential",
        "payload", "raw", "e", "error", "closeError",
    ])
    const violations = []

    for (const filePath of multiTypeScriptFiles(multiRoot)) {
        const sourceText = fs.readFileSync(filePath, "utf8")
        const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)
        const inspectLogArgument = (node, callLine) => {
            if (ts.isCallExpression(node)
                && ts.isIdentifier(node.expression)
                && node.expression.text === "failureCode") return
            if (ts.isCallExpression(node)
                && ts.isPropertyAccessExpression(node.expression)
                && node.expression.expression.getText(sourceFile) === "JSON"
                && node.expression.name.text === "stringify") {
                violations.push(`${path.relative(multiRoot, filePath)}:${callLine}: serialized payload`)
                return
            }
            if (ts.isPropertyAccessExpression(node)) {
                const boundedCoordinatorError = node.getText(sourceFile) === "hubAbort.error"
                if (!boundedCoordinatorError && forbiddenIdentifiers.has(node.name.text)) {
                    violations.push(`${path.relative(multiRoot, filePath)}:${callLine}: ${node.name.text}`)
                    return
                }
                inspectLogArgument(node.expression, callLine)
                return
            }
            if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) {
                violations.push(`${path.relative(multiRoot, filePath)}:${callLine}: ${node.text}`)
                return
            }
            node.forEachChild(child => inspectLogArgument(child, callLine))
        }
        const visit = node => {
            if (ts.isCallExpression(node)
                && ts.isPropertyAccessExpression(node.expression)
                && node.expression.expression.getText(sourceFile) === "console"
                && ["log", "warn", "error"].includes(node.expression.name.text)) {
                const callLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
                for (const argument of node.arguments) inspectLogArgument(argument, callLine)
            }
            node.forEachChild(visit)
        }
        visit(sourceFile)
    }

    assert.deepEqual(violations, [])
})
