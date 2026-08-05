/**
 * Mode seam registry.
 *
 * The base server carries no gameplay-mode logic. Modes ship as separately
 * installed modules (see loader.ts) and register handlers here. With no
 * modules installed every dispatch is a no-op, keeping base behaviour
 * byte-identical to a server built without the seam.
 *
 * Where a module's own configuration lives: in the module, not here. The
 * content registry belongs to the base server, and the seam does not extend
 * it for a mode's private tables — `ModeHost.table` reads base-registered
 * tables only. A module declares itself through its exported manifest and
 * may read files it ships alongside itself.
 *
 * Capability follows transaction context. Hooks that run inside an explicit
 * database transaction receive a `ModeTransactionHost` carrying write
 * primitives; hooks that run outside one receive a read-only `ModeHost` and
 * therefore cannot modify player data at all:
 *
 * | hook                    | transaction         | host      | throw means            |
 * | ----------------------- | ------------------- | --------- | ---------------------- |
 * | onQuestStart            | none (before entry) | read-only | deliberate veto        |
 * | onRushFinish            | inside finish tx    | writable  | roll back the whole tx |
 * | onRushPartiesSerialized | none (read path)    | read-only | skip this module       |
 *
 * onRushFinish deliberately propagates: it runs inside the settlement
 * transaction, so swallowing an error would let a module's partial writes
 * commit. Rolling the settlement back is the only outcome that cannot leave
 * torn player state.
 *
 * Ordering: modules run in registration order, which the loader fixes to the
 * code-point order of their file names, so a given modes.d/ always produces
 * the same sequence.
 */

/**
 * Contract version. The loader reads a module's exported manifest and
 * refuses a mismatched module *before* handing it a host, so an
 * incompatible module never gets to call one.
 */
export const MODE_API_VERSION = 1

export interface ModeHostServerApi {
    readonly getCharacterElement: (characterId: number) => number | null
    readonly updatePlayerEquipment: (
        playerId: number, equipmentId: number, patch: { level: number },
    ) => void
    readonly givePlayerCharactersExp: (
        playerId: number, characterIds: number[], amount: number,
    ) => unknown
}

/** Read-only host. Handed to hooks that do not run inside a transaction. */
export interface ModeHost {
    readonly apiVersion: number
    /**
     * Reads a table the base server has registered in its content registry.
     * Throws for anything else: the seam does not host mode-private tables,
     * and a mode's own switches belong in its manifest or its own files.
     */
    readonly table: <T>(tableName: string) => T
    readonly log: (message: string) => void
}

/**
 * Host for hooks that run inside an explicit transaction. Write primitives
 * exist only here, so a hook running outside a transaction cannot reach
 * player data even by accident.
 */
export interface ModeTransactionHost extends ModeHost {
    readonly server: ModeHostServerApi
}

export interface ModeRewardEntry {
    readonly kind: number
    readonly kind_id: number
    readonly number: number
}

export interface RushFinishExtension {
    readonly rush_battle_reward_list?: readonly ModeRewardEntry[]
}

export interface QuestStartContext {
    readonly playerId: number
    readonly questId: number
    readonly questCategory: number | null
}

export interface RushPartiesContext {
    readonly playerId: number
    readonly eventId: number
    /** Serialized played-party records, keyed by round. Mutated in place. */
    readonly folderParties: Record<number, Record<string, unknown>>
    readonly endlessParties: Record<number, Record<string, unknown>>
}

/**
 * Statically exported by a module as `modeManifest`, so the loader can check
 * compatibility before executing any module code that touches a host.
 */
export interface ModeManifest {
    readonly apiVersion: number
    readonly name: string
    readonly capability: string
}

/** Returned by a module's register(host); every hook is optional. */
export interface ModeHooks {
    /**
     * Runs before quest entry, outside any transaction, with a read-only
     * host. Throwing rejects the start; the message reaches the client and
     * later modules do not run.
     */
    readonly onQuestStart?: (context: QuestStartContext, host: ModeHost) => void
    /**
     * Runs inside the settlement transaction, immediately after
     * handleRushEventFinish, and receives the exact dependency-injected
     * params object the base handler received. Writes go through the
     * transaction host or those injected primitives, so they join the same
     * transaction. Throwing rolls the whole settlement back.
     */
    readonly onRushFinish?: (
        params: unknown,
        host: ModeTransactionHost,
    ) => RushFinishExtension | null | undefined
    /**
     * Runs just before played parties are returned to the client and may
     * mutate the records in place. Client-side character locking is derived
     * purely from these lists, so a mode can release the lock here while
     * keeping the entry count (and therefore round progression) intact.
     * Read-only host: this is a read path with no transaction.
     */
    readonly onRushPartiesSerialized?: (
        context: RushPartiesContext,
        host: ModeHost,
    ) => void
}

export interface ModeDefinition extends ModeManifest, ModeHooks {}

export interface LoadedModeIdentity {
    readonly fileName: string
    readonly name: string
    readonly capability: string
    readonly sha256: string
}

const modes: ModeDefinition[] = []
const loadedModeIdentities: LoadedModeIdentity[] = []

export function isModeManifest(value: unknown): value is ModeManifest {
    if (typeof value !== "object" || value === null) return false
    const candidate = value as Record<string, unknown>
    return typeof candidate.name === "string" && candidate.name !== ""
        && typeof candidate.capability === "string" && candidate.capability !== ""
        && typeof candidate.apiVersion === "number"
}

export function registerMode(
    mode: ModeDefinition,
    loadedIdentity?: LoadedModeIdentity,
): void {
    if (!isModeManifest(mode)) {
        throw new Error("mode definition requires apiVersion, name and capability")
    }
    if (mode.apiVersion !== MODE_API_VERSION) {
        throw new Error(
            `mode ${mode.name} targets mode API ${String(mode.apiVersion)}, `
            + `this server provides ${MODE_API_VERSION}`,
        )
    }
    if (modes.some(existing => existing.name === mode.name)) {
        throw new Error(`mode is already registered: ${mode.name}`)
    }
    if (loadedIdentity !== undefined
        && (loadedIdentity.name !== mode.name
            || loadedIdentity.capability !== mode.capability
            || !/^[^/\\]+\.mjs$/.test(loadedIdentity.fileName)
            || !/^[a-f0-9]{64}$/.test(loadedIdentity.sha256))) {
        throw new Error(`mode ${mode.name} has an invalid loaded identity`)
    }
    modes.push(mode)
    if (loadedIdentity !== undefined) {
        loadedModeIdentities.push(Object.freeze({ ...loadedIdentity }))
    }
}

export function resetModesForTest(): void {
    modes.length = 0
    loadedModeIdentities.length = 0
}

export function listModeCapabilities(): readonly string[] {
    return modes.map(mode => mode.capability)
}

export function listLoadedModeIdentities(): readonly LoadedModeIdentity[] {
    return Object.freeze([...loadedModeIdentities])
}

/**
 * Veto chain, outside any transaction: the first module to throw rejects the
 * start and later modules do not run. A throw here is a deliberate signal
 * rather than a fault, so it propagates to the caller.
 */
export function dispatchModeQuestStart(context: QuestStartContext, host: ModeHost): void {
    for (const mode of modes) {
        mode.onQuestStart?.(context, host)
    }
}

/**
 * Runs inside the settlement transaction. Exceptions propagate so the
 * transaction rolls back: a module that fails midway may already have
 * written, and completing the commit would persist that partial state.
 */
export function dispatchModeRushFinish(
    params: unknown,
    host: ModeTransactionHost,
): RushFinishExtension | null {
    const rewards: ModeRewardEntry[] = []
    for (const mode of modes) {
        const extension = mode.onRushFinish?.(params, host)
        if (extension?.rush_battle_reward_list?.length) {
            rewards.push(...extension.rush_battle_reward_list)
        }
    }
    return rewards.length > 0 ? { rush_battle_reward_list: rewards } : null
}

/**
 * Read path with no transaction and a read-only host, so a throwing module
 * cannot have left partial state: it is reported and skipped, and the
 * response keeps whatever earlier modules produced.
 */
export function dispatchModeRushParties(context: RushPartiesContext, host: ModeHost): void {
    for (const mode of modes) {
        if (!mode.onRushPartiesSerialized) continue
        try {
            mode.onRushPartiesSerialized(context, host)
        } catch (error) {
            host.log(
                `[modes] ${mode.name} failed and was skipped: `
                + `${(error as Error)?.message ?? String(error)}`,
            )
        }
    }
}
