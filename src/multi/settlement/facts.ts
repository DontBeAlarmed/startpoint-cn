import { randomUUID } from "node:crypto"

import {
    participantKey,
    type BattleSessionId,
    type CoordinatorResult,
    type ParticipantIdentity,
} from "../coordinator/contracts"
import type { BattleSessionInput, BattleStatus } from "../coordinator/interface"

export const MAX_BATTLE_FACT_RETENTION_MS = 30 * 60 * 1000
const DEFAULT_MAX_RECORDS = 4096

interface BattleFactRecord {
    readonly battleSessionId: BattleSessionId
    readonly roomNumber: string
    readonly host: ParticipantIdentity
    readonly participants: readonly ParticipantIdentity[]
    readonly participantKeys: ReadonlySet<string>
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
        if (active) return this.toStatus(active, input.host)

        const battleSessionId = this.createBattleSessionId() as BattleSessionId
        if (typeof battleSessionId !== "string"
            || battleSessionId.trim().length === 0
            || this.records.has(battleSessionId)) {
            throw new Error("battle session id is invalid or duplicated")
        }
        const participants = Object.freeze(input.participants.map(participant => (
            Object.freeze({ ...participant })
        )))
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
            finalizedParticipantKeys: new Set(),
            sequence: ++this.sequence,
            expiresAt: null,
        }
        this.records.set(battleSessionId, record)
        this.activeBattleByRoom.set(input.roomNumber, battleSessionId)
        this.prune()
        return this.toStatus(record, input.host)
    }

    getBattleStatus(input: BattleSessionInput): CoordinatorResult<BattleStatus> {
        this.prune()
        const record = this.records.get(input.battleSessionId)
        if (!record || record.roomNumber !== input.roomNumber) {
            return { ok: false, error: "ROOM_NOT_FOUND" }
        }
        if (!record.participantKeys.has(participantKey(
            input.participant.nodeSessionId,
            input.participant.viewerId,
        ))) {
            return { ok: false, error: "ROOM_PERMISSION_DENIED" }
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

    getActiveBattleSessionId(roomNumber: string): BattleSessionId | null {
        this.prune()
        return this.activeBattleByRoom.get(roomNumber) ?? null
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
        return Object.freeze({
            battleSessionId: record.battleSessionId,
            roomNumber: record.roomNumber,
            host: record.host,
            participants: record.participants,
            finalized: record.finalizedParticipantKeys.has(participantKey(
                participant.nodeSessionId,
                participant.viewerId,
            )),
        })
    }

    private prune(): void {
        const now = this.now()
        for (const [battleSessionId, record] of this.records) {
            if (record.expiresAt !== null && record.expiresAt <= now) {
                this.deleteRecord(battleSessionId, record)
            }
        }
        while (this.records.size > this.maxRecords) {
            let oldest: BattleFactRecord | null = null
            for (const record of this.records.values()) {
                if (oldest === null || record.sequence < oldest.sequence) oldest = record
            }
            if (oldest === null) break
            this.deleteRecord(oldest.battleSessionId, oldest)
        }
    }

    private deleteRecord(battleSessionId: BattleSessionId, record: BattleFactRecord): void {
        this.records.delete(battleSessionId)
        if (this.activeBattleByRoom.get(record.roomNumber) === battleSessionId) {
            this.activeBattleByRoom.delete(record.roomNumber)
        }
    }
}
