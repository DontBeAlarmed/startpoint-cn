export interface MultiTransportTuning {
    readonly handshakeTimeoutMs: number
    readonly maxFrameBytes: number
    readonly maxBufferBytes: number
    readonly keepAliveInitialDelayMs: number
    readonly sendQueueMaxMessages: number
    readonly sendQueueMaxBytes: number
    readonly sendQueueMaxAgeMs: number
}

export interface MultiBattleTuning {
    readonly loadingLeaseMs: number
    readonly heartbeatLeaseMs: number
}

export const DEFAULT_MULTI_TRANSPORT_TUNING: MultiTransportTuning = Object.freeze({
    handshakeTimeoutMs: 15_000,
    maxFrameBytes: 262_144,
    maxBufferBytes: 1_048_576,
    keepAliveInitialDelayMs: 10_000,
    sendQueueMaxMessages: 512,
    sendQueueMaxBytes: 4_194_304,
    sendQueueMaxAgeMs: 15_000,
})

export const DEFAULT_MULTI_BATTLE_TUNING: MultiBattleTuning = Object.freeze({
    loadingLeaseMs: 60_000,
    heartbeatLeaseMs: 25_000,
})
