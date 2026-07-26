/**
 * Mode seam registry (fork/dev-base).
 *
 * The base server carries no gameplay-mode logic. Modes ship as separately
 * installed modules (see loader.ts) and register handlers here. With no
 * modules installed every dispatch is a no-op, keeping base behaviour
 * byte-identical to upstream.
 *
 * Contract for handlers: activation is content-keyed — a handler must read
 * its activation table from the content snapshot (via ModeHost.table) as its
 * first step and return null/undefined when the table is absent or disabled.
 * ModeHost.table returns null for a table the snapshot does not carry, so an
 * unpublished activation table leaves the module inert rather than throwing.
 *
 * Ordering and failure model:
 * - Modules run in registration order, which the loader fixes to the
 *   code-point order of their file names, so a given modes.d/ always
 *   produces the same sequence.
 * - onQuestStart is a veto chain: the first module to throw rejects the
 *   start, later modules do not run, and the message reaches the client.
 * - onRushFinish and onRushPartiesSerialized are fail-soft: a module that
 *   throws is logged and skipped, and the base flow continues. Settlement
 *   has already committed the base rewards by then, so aborting the request
 *   would lose them.
 * - A module that writes player data during settlement must do so through
 *   the transaction primitive on the injected params object. Writes issued
 *   outside it are not rolled back when a later step fails.
 */

/**
 * Contract version. The loader refuses modules built against another major
 * version rather than letting a stale module see a changed host shape.
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

export interface ModeHost {
    /** The host's MODE_API_VERSION, so a module can branch on it. */
    readonly apiVersion: number
    /**
     * Reads a table from the process content snapshot, or null when the
     * snapshot does not carry it. A module whose activation table is absent
     * is expected to stay inert rather than fail.
     */
    readonly table: <T>(tableName: string) => T | null
    /** Same, but throws when the table is absent (use for hard dependencies). */
    readonly requireTable: <T>(tableName: string) => T
    readonly log: (message: string) => void
    /** Curated server primitives for mode modules (assembled by the loader). */
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

export interface ModeDefinition {
    /** Must equal MODE_API_VERSION; mismatched modules are refused. */
    readonly apiVersion: number
    readonly name: string
    readonly capability: string
    /**
     * Runs inside the same request as handleRushEventFinish, after it, and
     * receives the exact dependency-injected params object the base handler
     * received (domain primitives included). Side effects go through those
     * injected primitives; the returned reward list is appended to the
     * client-visible rush_battle_reward_list.
     */
    readonly onRushFinish?: (
        params: unknown,
        host: ModeHost,
    ) => RushFinishExtension | null | undefined
    /** May throw to reject the quest start; the message reaches the client. */
    readonly onQuestStart?: (context: QuestStartContext, host: ModeHost) => void
    /**
     * Runs just before played parties are returned to the client, and may
     * mutate the records in place. Client-side character locking is derived
     * purely from these lists, so a mode can release the lock here while
     * keeping the entry count (and therefore round progression) intact.
     */
    readonly onRushPartiesSerialized?: (
        context: RushPartiesContext,
        host: ModeHost,
    ) => void
}

const modes: ModeDefinition[] = []

export function registerMode(mode: ModeDefinition): void {
    if (!mode || typeof mode.name !== "string" || !mode.name
        || typeof mode.capability !== "string" || !mode.capability) {
        throw new Error("mode definition requires a name and a capability")
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
    modes.push(mode)
}

export function resetModesForTest(): void {
    modes.length = 0
}

export function listModeCapabilities(): readonly string[] {
    return modes.map(mode => mode.capability)
}

/**
 * Fail-soft hook invocation: a throwing module is reported and skipped so a
 * faulty module cannot take down a settlement the base server already
 * committed. Used for every hook except the quest-start veto.
 */
function runFailSoft(mode: ModeDefinition, host: ModeHost, run: () => void): void {
    try {
        run()
    } catch (error) {
        host.log(
            `[modes] ${mode.name} failed and was skipped: `
            + `${(error as Error)?.message ?? String(error)}`,
        )
    }
}

export function dispatchModeRushFinish(
    params: unknown,
    host: ModeHost,
): RushFinishExtension | null {
    const rewards: ModeRewardEntry[] = []
    for (const mode of modes) {
        if (!mode.onRushFinish) continue
        runFailSoft(mode, host, () => {
            const extension = mode.onRushFinish?.(params, host)
            if (extension?.rush_battle_reward_list?.length) {
                rewards.push(...extension.rush_battle_reward_list)
            }
        })
    }
    return rewards.length > 0 ? { rush_battle_reward_list: rewards } : null
}

/**
 * Veto chain: the first module to throw rejects the start and later modules
 * do not run. This is the one hook where a throw is a deliberate signal
 * rather than a fault, so it propagates to the caller.
 */
export function dispatchModeQuestStart(context: QuestStartContext, host: ModeHost): void {
    for (const mode of modes) {
        mode.onQuestStart?.(context, host)
    }
}

export function dispatchModeRushParties(context: RushPartiesContext, host: ModeHost): void {
    for (const mode of modes) {
        if (!mode.onRushPartiesSerialized) continue
        runFailSoft(mode, host, () => mode.onRushPartiesSerialized?.(context, host))
    }
}
