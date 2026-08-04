"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const {
    MULTI_PROTOCOL_VERSION,
    hasViewerIdConflict,
    participantKey,
} = require("../src/multi/coordinator/contracts")

const root = path.resolve(__dirname, "..")
const contractsModule = path.join(root, "src/multi/coordinator/contracts").replaceAll("\\", "/")
const interfaceModule = path.join(root, "src/multi/coordinator/interface").replaceAll("\\", "/")
const tscPath = path.join(root, "node_modules/typescript/bin/tsc")

function parseSource(relativePath) {
    const filePath = path.join(root, relativePath)
    const source = fs.readFileSync(filePath, "utf8")
    return {
        source,
        file: ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true),
    }
}

function findDeclaration(file, name, guard) {
    const declaration = file.statements.find(statement => (
        guard(statement) && statement.name?.text === name
    ))
    assert.ok(declaration, `${name} must be declared`)
    return declaration
}

function memberNames(declaration) {
    return declaration.members.map(member => member.name?.getText()).filter(Boolean)
}

function sortedMemberNames(declaration) {
    return memberNames(declaration).sort((left, right) => left.localeCompare(right))
}

test("participant keys include the node session identity", () => {
    assert.notEqual(
        participantKey("node-a", 800000001),
        participantKey("node-b", 800000001),
    )
})

test("viewer ids conflict only when they come from different node sessions", () => {
    const members = [{ nodeSessionId: "node-a", viewerId: 800000001 }]

    assert.equal(
        hasViewerIdConflict(members, { nodeSessionId: "node-b", viewerId: 800000001 }),
        true,
    )
    assert.equal(
        hasViewerIdConflict(members, { nodeSessionId: "node-a", viewerId: 800000001 }),
        false,
    )
})

test("protocol version starts at one", () => {
    assert.equal(MULTI_PROTOCOL_VERSION, 1)
})

test("participant keys reject invalid identities", () => {
    for (const [nodeSessionId, viewerId] of [
        ["", 800000001],
        ["node-a", 0],
        ["node-a", -1],
        ["node-a", 1.5],
        ["node-a", Number.MAX_SAFE_INTEGER + 1],
    ]) {
        assert.throws(
            () => participantKey(nodeSessionId, viewerId),
            { name: "TypeError", message: "invalid multi participant identity" },
        )
    }
})

test("coordinator types carry complete room operations", t => {
    const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-coordinator-types-"))
    const fixturePath = path.join(fixtureDirectory, "contracts.ts")
    t.after(() => fs.rmSync(fixtureDirectory, { force: true, recursive: true }))

    fs.writeFileSync(fixturePath, `
import {
    participantKey,
    type BattleSessionId,
    type CoordinatorResult,
    type MultiCompatibilityProfile,
    type NodeSessionId,
    type ParticipantIdentity,
} from ${JSON.stringify(contractsModule)}
import type {
    BattleStatus,
    CompatibleRoomInput,
    CreateRoomInput,
    MultiCoordinator,
    RoomLocator,
    RoomStatus,
} from ${JSON.stringify(interfaceModule)}

const nodeSessionId = "node-a" as NodeSessionId
const battleSessionId = "battle-a" as BattleSessionId
const participant: ParticipantIdentity = { nodeSessionId, viewerId: 800000001 }
const compatibility: MultiCompatibilityProfile = {
    protocolVersion: 1,
    appVersion: "1.8.1",
    resourceVersion: "1",
    cdnTargetVersion: "cn-1",
    contentDigest: "content",
    modeDigest: "modes",
}
const byNumber: RoomLocator = { roomNumber: "123456" }
const byToken: RoomLocator = { accessToken: "access-token" }
const compatibleByNumber: CompatibleRoomInput = {
    participant,
    compatibility,
    ...byNumber,
}
const compatibleByToken: CompatibleRoomInput = {
    participant,
    compatibility,
    ...byToken,
}
const createInput: CreateRoomInput = {
    requestId: "request-1",
    participant,
    localPlayerId: 17,
    partyId: 1,
    category: 1,
    questId: 1001,
    leaderCharacterId: 101,
    compatibility,
}
const roomStatus: RoomStatus = {
    roomNumber: "123456",
    accessToken: "access-token",
    category: 1,
    questId: 1001,
    host: participant,
    members: [participant],
    compatibility,
    battleSessionId,
}
const battleStatus: BattleStatus = {
    battleSessionId,
    roomNumber: roomStatus.roomNumber,
    participants: [participant],
    finalized: false,
}
const ok = <T>(value: T): Promise<CoordinatorResult<T>> => (
    Promise.resolve({ ok: true, value })
)
const coordinator: MultiCoordinator = {
    createRoom: () => ok(roomStatus),
    searchRoom: () => ok(roomStatus),
    prepareRoom: () => ok(roomStatus),
    selectRoom: () => ok(roomStatus),
    disbandRoom: () => ok(undefined),
    startBattle: () => ok(battleStatus),
    finalizeBattle: () => ok(battleStatus),
    getBattleStatus: () => ok(battleStatus),
    getRoomStatus: () => ok(roomStatus),
}

participantKey(nodeSessionId, participant.viewerId)
void coordinator.createRoom(createInput)
void coordinator.searchRoom(compatibleByNumber)
void coordinator.prepareRoom(compatibleByToken)

// @ts-expect-error participant identities require a branded node session id
const plainIdentity: ParticipantIdentity = { nodeSessionId: "node-a", viewerId: 1 }
// @ts-expect-error participantKey requires a branded node session id
participantKey("node-a", 1)
// @ts-expect-error a room locator requires exactly one locator field
const missingLocator: RoomLocator = {}
// @ts-expect-error a room locator cannot contain both locator fields
const duplicateLocator: RoomLocator = { roomNumber: "123456", accessToken: "token" }
// @ts-expect-error room status must carry access token and quest identity
const incompleteRoomStatus: RoomStatus = {
    roomNumber: "123456",
    host: participant,
    members: [participant],
    compatibility,
}
// @ts-expect-error coordinator methods must return a valid CoordinatorResult
const invalidCreateRoom: MultiCoordinator["createRoom"] = async () => ({ ok: false as const, error: "INVALID" as const })
const timedCompatibility: MultiCompatibilityProfile = {
    ...compatibility,
    // @ts-expect-error server time is not part of compatibility identity
    serverTime: 1,
}
// @ts-expect-error every compatibility field is required
const missingCompatibility: MultiCompatibilityProfile = {
    protocolVersion: 1,
    appVersion: "1.8.1",
    resourceVersion: "1",
    cdnTargetVersion: "cn-1",
    contentDigest: "content",
}

void plainIdentity
void missingLocator
void duplicateLocator
void incompleteRoomStatus
void invalidCreateRoom
void timedCompatibility
void missingCompatibility
`, "utf8")

    const result = spawnSync(process.execPath, [
        tscPath,
        "--strict",
        "--noEmit",
        "--skipLibCheck",
        "--module", "commonjs",
        "--moduleResolution", "node",
        "--target", "es2016",
        fixturePath,
    ], { cwd: root, encoding: "utf8" })

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
})

test("coordinator type contract stays narrow and node-scoped", () => {
    const contracts = parseSource("src/multi/coordinator/contracts.ts")
    const coordinator = parseSource("src/multi/coordinator/interface.ts")

    const participant = findDeclaration(contracts.file, "ParticipantIdentity", ts.isInterfaceDeclaration)
    assert.deepEqual(sortedMemberNames(participant), ["nodeSessionId", "viewerId"])

    const profile = findDeclaration(contracts.file, "MultiCompatibilityProfile", ts.isInterfaceDeclaration)
    assert.deepEqual(sortedMemberNames(profile), [
        "appVersion",
        "cdnTargetVersion",
        "contentDigest",
        "modeDigest",
        "protocolVersion",
        "resourceVersion",
    ])

    const errorCode = findDeclaration(contracts.file, "CoordinatorErrorCode", ts.isTypeAliasDeclaration)
    assert.deepEqual(
        errorCode.type.types.map(type => type.literal.text).sort(),
        [
            "HUB_UNAVAILABLE",
            "INCOMPATIBLE_ROOM",
            "QUEST_NOT_AVAILABLE",
            "ROOM_NOT_FOUND",
            "VIEWER_ID_CONFLICT",
        ],
    )

    const createRoomInput = findDeclaration(
        coordinator.file,
        "CreateRoomInput",
        ts.isInterfaceDeclaration,
    )
    assert.deepEqual(sortedMemberNames(createRoomInput), [
        "category",
        "compatibility",
        "leaderCharacterId",
        "localPlayerId",
        "participant",
        "partyId",
        "questId",
        "requestId",
    ])

    const roomStatus = findDeclaration(coordinator.file, "RoomStatus", ts.isInterfaceDeclaration)
    assert.deepEqual(sortedMemberNames(roomStatus), [
        "accessToken",
        "battleSessionId",
        "category",
        "compatibility",
        "host",
        "members",
        "questId",
        "roomNumber",
    ])

    const multiCoordinator = findDeclaration(
        coordinator.file,
        "MultiCoordinator",
        ts.isInterfaceDeclaration,
    )
    assert.deepEqual(sortedMemberNames(multiCoordinator), [
        "createRoom",
        "disbandRoom",
        "finalizeBattle",
        "getBattleStatus",
        "getRoomStatus",
        "prepareRoom",
        "searchRoom",
        "selectRoom",
        "startBattle",
    ])

    assert.match(coordinator.source, /Node-local only[^\n]*\n\s*readonly localPlayerId\?:/)
    assert.doesNotMatch(
        `${contracts.source}\n${coordinator.source}`,
        /SQLite|Database|rewardCallback/i,
    )
})
