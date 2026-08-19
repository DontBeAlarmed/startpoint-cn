import { randomUUID } from "node:crypto"

import {
    participantKey,
    type BattleSessionId,
    type CoordinatorResult,
    type NodeSessionId,
    type ParticipantIdentity,
} from "../coordinator/contracts"
import type {
    BattleSessionInput,
    BattleStatus,
    RoomParticipantInput,
} from "../coordinator/interface"

export const MAX_BATTLE_FACT_RETENTION_MS = 30 * 60 * 1000
const DEFAULT_MAX_RECORDS = 4096

interface BattleFactRecord {
    readonly battleSessionId: BattleSessionId
    readonly roomNumber: string
    host: ParticipantIdentity
    readonly participants: ParticipantIdentity[]
    readonly participantKeys: Set<string>
    readonly credentialIdByParticipantKey: Map<string, string>
    readonly finalizedParticipantKeys: Set<string>
    readonly sequence: number
    expiresAt: number | null
}

export interface StartBattleFactsInput {
    readonly roomNumber: string
    readonly host: ParticipantIdentity
    readonly participants: readonly ParticipantIdentity[]
}

export interface BattleFactStoreOptions {
    readonly now?: () => number
    readonly createBattleSessionId?: () => string
    readonly retentionMs?: number
    readonly maxRecords?: number
}

export interface BattleFactCounts {
    readonly active: number
    readonly finalized: number
}

export class BattleFactStore {
    private readonly now: () => number
    private readonly createBattleSessionId: () => string
    private readonly retentionMs: number
    private readonly maxRecords: number
    private readonly records = new Map<BattleSessionId, BattleFactRecord>()
    private readonly activeBattleByRoom = new Map<string, BattleSessionId>()
    private sequence = 0

    constructor(options: BattleFactStoreOptions = {}) {
        this.now = options.now ?? Date.now
        this.createBattleSessionId = options.createBattleSessionId ?? randomUUID
        this.retentionMs = options.retentionMs ?? MAX_BATTLE_FACT_RETENTION_MS
        this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS
        if (!Number.isSafeInteger(this.retentionMs)
            || this.retentionMs <= 0
            || this.retentionMs > MAX_BATTLE_FACT_RETENTION_MS
            || !Number.isSafeInteger(this.maxRecords)
            || this.maxRecords <= 0) {
            throw new TypeError("battle fact limits are invalid")
        }
    }

    startBattle(input: StartBattleFactsInput): BattleStatus {
        this.prune()
        const activeId = this.activeBattleByRoom.get(input.roomNumber)
        const active = activeId ? this.records.get(activeId) : undefined
        if (active) {
            if (active.finalizedParticipantKeys.size > 0) {
                throw new Error("battle session is finalized")
            }
            return this.toStatus(active, input.host)
        }

        const capacityEvictions = this.getCapacityEvictions()
        if (capacityEvictions === null) {
            throw new Error("battle fact capacity is exhausted")
        }

        const battleSessionId = this.createBattleSessionId() as BattleSessionId
        if (typeof battleSessionId !== "string"
            || battleSessionId.trim().length === 0
            || this.records.has(battleSessionId)) {
            throw new Error("battle session id is invalid or duplicated")
        }
        const participants = input.participants.map(participant => (
            Object.freeze({ ...participant })
        ))
        const host = Object.freeze({ ...input.host })
        const participantKeys = new Set(participants.map(participant => participantKey(
            participant.nodeSessionId,
            participant.viewerId,
        )))
        if (!participantKeys.has(participantKey(host.nodeSessionId, host.viewerId))) {
            throw new TypeError("battle host must be a participant")
        }
        const record: BattleFactRecord = {
            battleSessionId,
            roomNumber: input.roomNumber,
            host,
            participants,
            participantKeys,
            credentialIdByParticipantKey: new Map(),
            finalizedParticipantKeys: new Set(),
            sequence: ++this.sequence,
            expiresAt: null,
        }
        for (const retained of capacityEvictions) {
            this.deleteRecord(retained.battleSessionId, retained)
        }
        this.records.set(battleSessionId, record)
        this.activeBattleByRoom.set(input.roomNumber, battleSessionId)
        return this.toStatus(record, input.host)
    }

    getBattleStatus(input: BattleSessionInput): CoordinatorResult<BattleStatus> {
        this.prune()
        const record = this.records.get(input.battleSessionId)
        if (!record || record.roomNumber !== input.roomNumber) {
            return { ok: false, error: "ROOM_NOT_FOUND" }
        }
        if (!this.isAuthorized(record, input)) {
            return { ok: false, error: "ROOM_PERMISSION_DENIED" }
        }
        return { ok: true, value: this.toStatus(record, input.participant) }
    }

    authorizeParticipant(input: BattleSessionInput): CoordinatorResult<BattleStatus> {
        this.prune()
        const record = this.records.get(input.battleSessionId)
        if (!record || record.roomNumber !== input.roomNumber) {
            return { ok: false, error: "ROOM_NOT_FOUND" }
        }
        if (!this.isAuthorized(record, input)) {
            return { ok: false, error: "ROOM_PERMISSION_DENIED" }
        }
        if (input.credentialId !== undefined) {
            record.credentialIdByParticipantKey.set(
                participantKey(input.participant.nodeSessionId, input.participant.viewerId),
                input.credentialId,
            )
        }
        return { ok: true, value: this.toStatus(record, input.participant) }
    }

    markFinalized(input: BattleSessionInput): CoordinatorResult<BattleStatus> {
        const result = this.getBattleStatus(input)
        if (!result.ok) return result
        const record = this.records.get(input.battleSessionId)
        if (!record) return { ok: false, error: "ROOM_NOT_FOUND" }
        record.finalizedParticipantKeys.add(participantKey(
            input.participant.nodeSessionId,
            input.participant.viewerId,
        ))
        record.expiresAt ??= this.now() + this.retentionMs
        return { ok: true, value: this.toStatus(record, input.participant) }
    }

    removeParticipant(input: RoomParticipantInput): CoordinatorResult<BattleStatus | null> {
        this.prune()
        const battleSessionId = this.activeBattleByRoom.get(input.roomNumber)
        const record = battleSessionId ? this.records.get(battleSessionId) : undefined
        if (!record) return { ok: true, value: null }
        const requestedKey = participantKey(
            input.participant.nodeSessionId,
            input.participant.viewerId,
        )
        const participantIndex = record.participants.findIndex(candidate => (
            participantKey(candidate.nodeSessionId, candidate.viewerId) === requestedKey
        ))
        if (participantIndex < 0) return { ok: true, value: null }
        if (!this.isAuthorized(record, {
            ...input,
            battleSessionId: record.battleSessionId,
        })) {
            return { ok: false, error: "ROOM_PERMISSION_DENIED" }
        }
        this.removeRecordParticipant(record, participantIndex)
        return { ok: true, value: this.toStatus(record, input.participant) }
    }

    removeParticipantsByNodeSession(
        roomNumber: string,
        nodeSessionId: NodeSessionId,
    ): BattleStatus | null {
        this.prune()
        const battleSessionId = this.activeBattleByRoom.get(roomNumber)
        const record = battleSessionId ? this.records.get(battleSessionId) : undefined
        if (!record) return null
        let removed = false
        for (let index = record.participants.length - 1; index >= 0; index--) {
            if (record.participants[index].nodeSessionId !== nodeSessionId) continue
            this.removeRecordParticipant(record, index)
            removed = true
        }
        return removed ? this.toStatus(record, record.host) : null
    }

    hasAnyFinalized(input: Pick<BattleSessionInput, "roomNumber" | "battleSessionId">): boolean {
        this.prune()
        const record = this.records.get(input.battleSessionId)
        return record?.roomNumber === input.roomNumber && record.finalizedParticipantKeys.size > 0
    }

    isFullyFinalized(input: Pick<BattleSessionInput, "roomNumber" | "battleSessionId">): boolean {
        this.prune()
        const record = this.records.get(input.battleSessionId)
        return record?.roomNumber === input.roomNumber
            && record.finalizedParticipantKeys.size === record.participants.length
    }

    getActiveBattleSessionId(roomNumber: string): BattleSessionId | null {
        this.prune()
        return this.activeBattleByRoom.get(roomNumber) ?? null
    }

    getCounts(): BattleFactCounts {
        this.prune()
        let active = 0
        let finalized = 0
        for (const record of this.records.values()) {
            if (record.finalizedParticipantKeys.size > 0) finalized++
            else active++
        }
        return Object.freeze({ active, finalized })
    }

    releaseRoom(roomNumber: string): void {
        const battleSessionId = this.activeBattleByRoom.get(roomNumber)
        this.activeBattleByRoom.delete(roomNumber)
        if (battleSessionId !== undefined) {
            const record = this.records.get(battleSessionId)
            if (record?.finalizedParticipantKeys.size === 0) {
                this.records.delete(battleSessionId)
            }
        }
        this.prune()
    }

    private toStatus(record: BattleFactRecord, participant: ParticipantIdentity): BattleStatus {
        const requestedKey = participantKey(participant.nodeSessionId, participant.viewerId)
        const participants = record.participants.map(candidate => (
            participantKey(candidate.nodeSessionId, candidate.viewerId) === requestedKey
                ? Object.freeze({ ...participant })
                : candidate
        ))
        const host = participantKey(record.host.nodeSessionId, record.host.viewerId) === requestedKey
            ? Object.freeze({ ...participant })
            : record.host
        return Object.freeze({
            battleSessionId: record.battleSessionId,
            roomNumber: record.roomNumber,
            host,
            participants: Object.freeze(participants),
            finalized: record.finalizedParticipantKeys.has(requestedKey),
        })
    }

    private isAuthorized(record: BattleFactRecord, input: BattleSessionInput): boolean {
        const requestedKey = participantKey(
            input.participant.nodeSessionId,
            input.participant.viewerId,
        )
        const credentialId = record.credentialIdByParticipantKey.get(requestedKey)
        if (credentialId !== undefined
            && input.credentialId !== undefined
            && credentialId !== input.credentialId) {
            return false
        }
        if (record.participantKeys.has(requestedKey)) return true
        if (input.credentialId === undefined) return false

        const reboundKey = [...record.credentialIdByParticipantKey.entries()]
            .find(([candidateKey, candidateCredentialId]) => (
                candidateCredentialId === input.credentialId
                && record.participants.some(candidate => (
                    participantKey(candidate.nodeSessionId, candidate.viewerId) === candidateKey
                    && candidate.viewerId === input.participant.viewerId
                ))
            ))?.[0]
        if (reboundKey === undefined) return false
        this.rebindParticipant(record, reboundKey, input.participant)
        return true
    }

    private rebindParticipant(
        record: BattleFactRecord,
        previousKey: string,
        participant: ParticipantIdentity,
    ): void {
        const index = record.participants.findIndex(candidate => (
            participantKey(candidate.nodeSessionId, candidate.viewerId) === previousKey
        ))
        if (index < 0) return
        const nextKey = participantKey(participant.nodeSessionId, participant.viewerId)
        if (previousKey === nextKey) return
        if (record.participantKeys.has(nextKey)) return

        const rebound = Object.freeze({ ...participant })
        record.participants[index] = rebound
        record.participantKeys.delete(previousKey)
        record.participantKeys.add(nextKey)
        const credentialId = record.credentialIdByParticipantKey.get(previousKey)
        record.credentialIdByParticipantKey.delete(previousKey)
        if (credentialId !== undefined) {
            record.credentialIdByParticipantKey.set(nextKey, credentialId)
        }
        if (record.finalizedParticipantKeys.delete(previousKey)) {
            record.finalizedParticipantKeys.add(nextKey)
        }
        if (participantKey(record.host.nodeSessionId, record.host.viewerId) === previousKey) {
            record.host = rebound
        }
    }

    private removeRecordParticipant(record: BattleFactRecord, index: number): void {
        const [participant] = record.participants.splice(index, 1)
        const removedKey = participantKey(
            participant.nodeSessionId,
            participant.viewerId,
        )
        record.participantKeys.delete(removedKey)
        record.credentialIdByParticipantKey.delete(removedKey)
        record.finalizedParticipantKeys.delete(removedKey)
    }

    private prune(): void {
        const now = this.now()
        for (const [battleSessionId, record] of this.records) {
            if (this.isRetained(record)
                && record.expiresAt !== null
                && record.expiresAt <= now) {
                this.deleteRecord(battleSessionId, record)
            }
        }
    }

    private getCapacityEvictions(): BattleFactRecord[] | null {
        const required = this.records.size - this.maxRecords + 1
        if (required <= 0) return []
        const retained = [...this.records.values()]
            .filter(record => this.isRetained(record))
            .sort((left, right) => left.sequence - right.sequence)
        return retained.length >= required ? retained.slice(0, required) : null
    }

    private isRetained(record: BattleFactRecord): boolean {
        return record.finalizedParticipantKeys.size > 0
            && record.expiresAt !== null
            && this.activeBattleByRoom.get(record.roomNumber) !== record.battleSessionId
    }

    private deleteRecord(battleSessionId: BattleSessionId, record: BattleFactRecord): void {
        this.records.delete(battleSessionId)
        if (this.activeBattleByRoom.get(record.roomNumber) === battleSessionId) {
            this.activeBattleByRoom.delete(record.roomNumber)
        }
    }
}
