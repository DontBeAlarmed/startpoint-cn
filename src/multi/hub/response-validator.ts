import type { RoomAdmission } from "../admission/registry"
import {
    MULTI_PROTOCOL_VERSION,
    type NodeSessionId,
    type ParticipantIdentity,
} from "../coordinator/contracts"
import type { BattleStatus, RoomStatus } from "../coordinator/interface"
import type {
    MultiOption,
    PlayerCharacterSnapshot,
    PlayerEquipmentSnapshot,
    PlayerPartySnapshot,
    PlayerSnapshot,
} from "../snapshot/player-snapshot"
import { isValidNetworkHost } from "../../runtime/network-host"
import { isDiagnosticVersion } from "../../lib/diagnostic-version"
import type { CompatibilityRejectionSummary } from "../../lib/admin-multi-status"
import type { MultiHubControlStatus, MultiHubTcpEndpoint } from "./control-routes"

type Validator = (value: unknown) => boolean

const ROOM_ROUTES = new Set([
    "/v1/multi/rooms/create",
    "/v1/multi/rooms/search",
    "/v1/multi/rooms/prepare",
    "/v1/multi/rooms/select",
    "/v1/multi/rooms/status",
])
const BATTLE_ROUTES = new Set([
    "/v1/multi/battles/start",
    "/v1/multi/battles/finalize",
    "/v1/multi/battles/status",
])
const VOID_ROUTES = new Set([
    "/v1/multi/rooms/disband",
    "/v1/multi/battles/abort",
])
const CONTROL_DIAGNOSTIC_FIELDS = Object.freeze([
    "activeRooms",
    "activeBattleFacts",
    "finalizedBattleFacts",
    "latestCompatibilityRejection",
] as const)
const REJECTION_FIELDS = new Set(["code", "differences", "timestamp"])
const COMPATIBILITY_FIELDS = new Set([
    "multiProtocolVersion",
    "APP_VER",
    "RES_VER",
    "cdnTargetVersion",
    "contentDigest",
    "modeDigest",
])
const VERSION_VALUE_FIELDS = new Set(["APP_VER", "RES_VER", "cdnTargetVersion"])

export interface HubNodeSessionPayload {
    readonly nodeSessionId: NodeSessionId
    readonly sessionCredential: string
    readonly expiresAt: number
    readonly tcp: MultiHubTcpEndpoint
}

export function isHubNodeSessionPayload(value: unknown): value is HubNodeSessionPayload {
    if (!isRecord(value) || !isRecord(value.tcp)) return false
    return isNodeSessionId(value.nodeSessionId)
        && typeof value.sessionCredential === "string"
        && /^[A-Za-z0-9_-]{43}$/.test(value.sessionCredential)
        && isPositiveInteger(value.expiresAt)
        && isTcpEndpoint(value.tcp)
}

export function isHubSuccessValue<T>(route: string, value: unknown): value is T {
    if (ROOM_ROUTES.has(route)) return isRoomStatus(value)
    if (BATTLE_ROUTES.has(route)) return isBattleStatus(value)
    if (route === "/v1/multi/admissions/issue") return isRoomAdmission(value)
    if (VOID_ROUTES.has(route)) return value === undefined
    return false
}

export function isHubControlStatus(value: unknown): value is MultiHubControlStatus {
    return parseHubControlStatus(value) !== null
}

export function parseHubControlStatus(value: unknown): MultiHubControlStatus | null {
    if (!isRecord(value)
        || !isNonNegativeInteger(value.activeNodeSessions)
        || !isNonNegativeInteger(value.enabledCredentials)) return null
    const core = {
        activeNodeSessions: value.activeNodeSessions,
        enabledCredentials: value.enabledCredentials,
        ...(typeof value.tcpAvailable === "boolean"
            ? { tcpAvailable: value.tcpAvailable }
            : {}),
    }
    const hasCompleteDiagnostics = CONTROL_DIAGNOSTIC_FIELDS.every(field => (
        Object.prototype.hasOwnProperty.call(value, field)
    ))
    if (!hasCompleteDiagnostics
        || !isNonNegativeInteger(value.activeRooms)
        || !isNonNegativeInteger(value.activeBattleFacts)
        || !isNonNegativeInteger(value.finalizedBattleFacts)
        || !isCompatibilityRejection(value.latestCompatibilityRejection)) {
        return Object.freeze(core)
    }
    return Object.freeze({
        ...core,
        activeRooms: value.activeRooms,
        activeBattleFacts: value.activeBattleFacts,
        finalizedBattleFacts: value.finalizedBattleFacts,
        latestCompatibilityRejection: value.latestCompatibilityRejection,
    })
}

function isCompatibilityRejection(
    value: unknown,
): value is CompatibilityRejectionSummary | null {
    if (value === null) return true
    if (!isRecord(value)
        || !hasOnlyKeys(value, REJECTION_FIELDS)
        || value.code !== "INCOMPATIBLE_ROOM"
        || !Array.isArray(value.differences)
        || value.differences.length > 6
        || typeof value.timestamp !== "string"
        || !Number.isFinite(new Date(value.timestamp).getTime())) return false
    return value.differences.every(isCompatibilityRejectionDifference)
}

function isCompatibilityRejectionDifference(value: unknown): boolean {
    if (!isRecord(value)
        || typeof value.field !== "string"
        || !COMPATIBILITY_FIELDS.has(value.field)
        || value.different !== true) return false
    const keys = Object.keys(value)
    if (!VERSION_VALUE_FIELDS.has(value.field)) {
        return keys.length === 2 && keys.every(key => key === "field" || key === "different")
    }
    if (keys.length === 2) {
        return keys.every(key => key === "field" || key === "different")
    }
    return keys.length === 4
        && keys.every(key => (
            key === "field" || key === "different" || key === "required" || key === "received"
        ))
        && isDiagnosticVersion(value.required)
        && isDiagnosticVersion(value.received)
}

function isRoomStatus(value: unknown): value is RoomStatus {
    if (!isRecord(value)) return false
    return isNonEmptyString(value.roomNumber)
        && isNonEmptyString(value.accessToken)
        && isPositiveInteger(value.category)
        && isPositiveInteger(value.questId)
        && isNonNegativeInteger(value.hostEntryTime)
        && isNonNegativeInteger(value.roomSequence)
        && isNonNegativeInteger(value.raisingState)
        && isNonNegativeInteger(value.shareRoomOptions)
        && isPositiveInteger(value.hostMainCharacterId)
        && typeof value.isNpcMode === "boolean"
        && typeof value.hostOnline === "boolean"
        && isParticipant(value.host)
        && isArrayOf(value.members, isParticipant)
        && isCompatibility(value.compatibility)
        && (value.battleSessionId === undefined || isNonEmptyString(value.battleSessionId))
}

function isBattleStatus(value: unknown): value is BattleStatus {
    if (!isRecord(value)) return false
    const host = value.host
    const participants = value.participants
    if (!isNonEmptyString(value.battleSessionId)
        || !isNonEmptyString(value.roomNumber)
        || !isParticipant(host)
        || !Array.isArray(participants)
        || !participants.every(isParticipant)
        || typeof value.finalized !== "boolean") return false
    return participants.some(participant => (
        participant.nodeSessionId === host.nodeSessionId
        && participant.viewerId === host.viewerId
    ))
}

function isRoomAdmission(value: unknown): value is RoomAdmission {
    if (!isRecord(value)) return false
    const participant = value.participant
    const snapshot = value.snapshot
    return isNonEmptyString(value.roomNumber)
        && isParticipant(participant)
        && isPlayerSnapshot(snapshot)
        && snapshot.viewerId === participant.viewerId
        && isPositiveInteger(value.expiresAt)
}

function isPlayerSnapshot(value: unknown): value is PlayerSnapshot {
    if (!isRecord(value)) return false
    return isPositiveInteger(value.viewerId)
        && typeof value.name === "string"
        && isPositiveInteger(value.rank)
        && isPositiveInteger(value.degreeId)
        && isPositiveInteger(value.mainCharacterId)
        && isPositiveInteger(value.playerRoleKind)
        && typeof value.isNewbie === "boolean"
        && isPositiveInteger(value.currentPartyId)
        && isPartySnapshot(value.party)
        && isArrayOf(value.npcParties, isPartySnapshot)
}

function isPartySnapshot(value: unknown): value is PlayerPartySnapshot {
    if (!isRecord(value)) return false
    return isPartyOptionArray(value.characters, isCharacterSnapshot)
        && isPartyOptionArray(value.unison_characters, isCharacterSnapshot)
        && isPartyOptionArray(value.equipments, isEquipmentSnapshot)
        && isPartyOptionArray(value.abilitySoulIds, isPositiveInteger)
}

function isPartyOptionArray<T>(
    value: unknown,
    validator: (candidate: unknown) => candidate is T,
): value is readonly MultiOption<T>[] {
    return Array.isArray(value)
        && value.length === 3
        && value.every(candidate => isOption(candidate, validator))
}

function isCharacterSnapshot(value: unknown): value is PlayerCharacterSnapshot {
    if (!isRecord(value) || !isRecord(value.mana_node_ids)) return false
    return isPositiveInteger(value.id)
        && isNonNegativeInteger(value.evolution_level)
        && isNonNegativeInteger(value.exp)
        && isNonNegativeInteger(value.over_limit_step)
        && Object.values(value.mana_node_ids).every(isNonNegativeInteger)
        && isOption(value.ex_boost, isExBoost)
        && isOption(value.illustration_settings, isNumberArray)
}

function isExBoost(value: unknown): value is {
    readonly ability_id_list: readonly number[]
    readonly status_id: number
} {
    if (!isRecord(value)) return false
    return isArrayOf(value.ability_id_list, isPositiveInteger)
        && isPositiveInteger(value.status_id)
}

function isEquipmentSnapshot(value: unknown): value is PlayerEquipmentSnapshot {
    if (!isRecord(value)) return false
    return isPositiveInteger(value.equipmentId)
        && isNonNegativeInteger(value.level)
        && isNonNegativeInteger(value.enhancementLevel)
}

function isOption<T>(
    value: unknown,
    validator: (candidate: unknown) => candidate is T,
): value is MultiOption<T> {
    return Array.isArray(value)
        && ((value.length === 1 && value[0] === 1)
            || (value.length === 2 && value[0] === 0 && validator(value[1])))
}

function isCompatibility(value: unknown): boolean {
    if (!isRecord(value)) return false
    return value.multiProtocolVersion === MULTI_PROTOCOL_VERSION
        && isNonEmptyString(value.APP_VER)
        && isNonEmptyString(value.RES_VER)
        && isNonEmptyString(value.cdnTargetVersion)
        && isSha256(value.contentDigest)
        && isSha256(value.modeDigest)
}

function isParticipant(value: unknown): value is ParticipantIdentity {
    return isRecord(value)
        && isNodeSessionId(value.nodeSessionId)
        && isPositiveInteger(value.viewerId)
}

function isTcpEndpoint(value: Record<string, unknown>): boolean {
    return isValidNetworkHost(value.host)
        && isPositiveInteger(value.port)
        && value.port <= 65535
}

function isNodeSessionId(value: unknown): value is NodeSessionId {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
    return Object.keys(value).every(key => allowed.has(key))
}

function isArrayOf(value: unknown, validator: Validator): boolean {
    return Array.isArray(value) && value.every(validator)
}

function isNumberArray(value: unknown): value is readonly number[] {
    return isArrayOf(value, isNonNegativeInteger)
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0
}

function isSha256(value: unknown): boolean {
    return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)
}
