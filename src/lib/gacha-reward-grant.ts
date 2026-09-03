import {
    createRewardGrantExecutionPlan,
    snapshotRewardGrantExecutionResultForPlan,
    withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync,
    type RewardGrantExecutionPlan,
    type RewardGrantExecutionResult,
} from "./reward-grant"
import type { InventoryBatchContext } from "./inventory"
import { RewardType } from "./types/rewards"
import type {
    Gacha,
    GachaCharacterDraw,
    GachaDraws,
    RewardPlayerGachaDrawResult,
} from "./types"
import { GachaType } from "./types"
import type { GachaDrawMetadata } from "./gacha-draw"
import {
    computeEquipmentGachaMovieEffectsForGacha,
    type EquipmentMovieDrawInput,
} from "./gacha-equipment-movie"
import { getDefaultGachaSeedQuarantine } from "./gacha-seed-quarantine"
import { formatGachaCharacterDrawsSummary } from "./hot-path-log-formatters"
import { sampledLog } from "./sampled-log"

export interface PlannedCharacterGachaMovie {
    characterId: number
    rarity: number
    movieId: string
    seed: number
    requiresVerification: boolean
}

export interface GachaRewardKnownPlayerState {
    readonly id: number
    readonly freeMana: number
    readonly freeVmoney: number
    readonly expPool: number
}
export type GachaRewardGrantOwner = (
    plan: RewardGrantExecutionPlan,
) => RewardGrantExecutionResult

export interface GachaRewardGrantOptions {
    readonly ownerGrant: GachaRewardGrantOwner
    readonly deferCharacterSampledLog?: (log: () => void) => void
}

export class GachaRewardGrantMismatchError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "GachaRewardGrantMismatchError"
    }
}
const gachaSeedQuarantine = getDefaultGachaSeedQuarantine()

function createPlan(
    kind: "character" | "equipment",
    drawResult: readonly number[],
): RewardGrantExecutionPlan {
    const rewardType = kind === "character" ? RewardType.CHARACTER : RewardType.EQUIPMENT
    return createRewardGrantExecutionPlan(drawResult.map(rewardId => (
        kind === "character"
            ? { type: rewardType as RewardType.CHARACTER, id: rewardId }
            : { type: rewardType as RewardType.EQUIPMENT, id: rewardId, count: 1 }
    )))
}

function assertPlanMatchesDrawResult(
    plan: RewardGrantExecutionPlan,
    kind: "character" | "equipment",
    drawResult: readonly number[],
): void {
    if (plan.entries.length !== drawResult.length) {
        throw new GachaRewardGrantMismatchError("Gacha reward plan length does not match draw result")
    }
    for (let index = 0; index < drawResult.length; index += 1) {
        const entry = plan.entries[index]
        if (!("id" in entry)
            || entry.id !== drawResult[index]
            || entry.type !== (kind === "character" ? RewardType.CHARACTER : RewardType.EQUIPMENT)) {
            throw new GachaRewardGrantMismatchError(
                `Gacha reward plan at index ${index} does not match draw result`,
            )
        }
    }
}

function assertCharacterMoviePlan(
    drawResult: readonly number[],
    moviePlan: readonly PlannedCharacterGachaMovie[],
): void {
    if (moviePlan.length !== drawResult.length
        || moviePlan.some((plan, index) => plan.characterId !== drawResult[index])) {
        throw new GachaRewardGrantMismatchError(
            "Character gacha movie plan does not match draw result",
        )
    }
}

function assertEquipmentMetadata(
    drawResult: readonly number[],
    metadata: readonly GachaDrawMetadata[] | undefined,
): asserts metadata is readonly GachaDrawMetadata[] {
    if (metadata === undefined
        || metadata.length !== drawResult.length
        || metadata.some((entry, index) => entry.id !== drawResult[index])) {
        throw new GachaRewardGrantMismatchError(
            "Equipment gacha metadata does not match draw result",
        )
    }
}

function validateGrant(
    playerId: number,
    plan: RewardGrantExecutionPlan,
    grant: RewardGrantExecutionResult,
): RewardGrantExecutionResult {
    return snapshotRewardGrantExecutionResultForPlan(playerId, plan, grant)
}

export function grantGachaRewardPlanInTransactionOwnerWithInventorySync(
    playerId: number,
    plan: RewardGrantExecutionPlan,
    knownPlayerBefore: GachaRewardKnownPlayerState,
    inventory: InventoryBatchContext,
): RewardGrantExecutionResult {
    return withRewardGrantExecutionPlanAsTransactionOwnerWithInventorySync(
        playerId,
        plan,
        {
            playerId: knownPlayerBefore.id,
            freeMana: knownPlayerBefore.freeMana,
            freeVmoney: knownPlayerBefore.freeVmoney,
            expPool: knownPlayerBefore.expPool,
        },
        inventory,
        execution => {
            const result = validateGrant(playerId, plan, execution.result)
            execution.finalize()
            return result
        },
    )
}

function scheduleCharacterLog(
    playerId: number,
    draws: readonly GachaCharacterDraw[],
    moviePlans: readonly PlannedCharacterGachaMovie[],
    deferLog: GachaRewardGrantOptions["deferCharacterSampledLog"],
): void {
    const drawSnapshot = draws.map(draw => ({
        ...draw,
        ...(draw.ex_boost_item === undefined || Array.isArray(draw.ex_boost_item)
            ? {}
            : { ex_boost_item: { ...draw.ex_boost_item } }),
    }))
    const moviePlanSnapshot = moviePlans.map(plan => ({ ...plan }))
    const log = () => sampledLog("gacha-character-draws", () =>
        formatGachaCharacterDrawsSummary({
            playerId,
            draws: drawSnapshot,
            moviePlans: moviePlanSnapshot,
        }))
    if (deferLog === undefined) log()
    else deferLog(log)
}

function projectCharacters(
    playerId: number,
    grant: RewardGrantExecutionResult,
    drawResult: readonly number[],
    moviePlan: readonly PlannedCharacterGachaMovie[],
    deferLog: GachaRewardGrantOptions["deferCharacterSampledLog"],
): RewardPlayerGachaDrawResult {
    const draws: GachaCharacterDraw[] = []
    const characters = new Map<number, Object>()
    const items: Record<number, number> = {}

    for (let index = 0; index < grant.entries.length; index += 1) {
        const entry = grant.entries[index]
        const plannedMovie = moviePlan[index]
        if (entry.outcome.kind !== "character") {
            throw new GachaRewardGrantMismatchError(
                `Character gacha reward result at index ${index} is invalid`,
            )
        }
        const characterId = drawResult[index]
        const character = entry.outcome.after
        const draw: GachaCharacterDraw = {
            character_id: characterId,
            movie_id: plannedMovie.movieId,
            seed: plannedMovie.seed,
            entry_count: 1,
        }

        if (!plannedMovie.requiresVerification) {
            characters.set(characterId, character)
            draws.push(draw)
            continue
        }

        gachaSeedQuarantine.markSent(
            plannedMovie.movieId,
            plannedMovie.seed,
            plannedMovie.rarity,
        )
        const compensation = entry.outcome.compensationItem
        if (compensation !== null) {
            draw.ex_boost_item = {
                id: compensation.itemId,
                count: compensation.acceptedAmount,
            }
            items[compensation.itemId] = compensation.afterAmount
        }

        const existingCharacter = characters.get(characterId)
        characters.set(characterId, existingCharacter === undefined
            ? character
            : { ...existingCharacter, ...character })
        draws.push(draw)
    }

    scheduleCharacterLog(playerId, draws, moviePlan, deferLog)
    return {
        draw: draws,
        characters: [...characters.values()],
        equipment: [],
        items,
    }
}

function projectEquipment(
    grant: RewardGrantExecutionResult,
    drawResult: readonly number[],
    effects: ReturnType<typeof computeEquipmentGachaMovieEffectsForGacha>,
): RewardPlayerGachaDrawResult {
    const draws: GachaDraws = []
    const equipment = new Map<number, Object>()
    for (let index = 0; index < grant.entries.length; index += 1) {
        const entry = grant.entries[index]
        if (entry.outcome.kind !== "equipment") {
            throw new GachaRewardGrantMismatchError(
                `Equipment gacha reward result at index ${index} is invalid`,
            )
        }
        const equipmentId = drawResult[index]
        equipment.set(equipmentId, entry.outcome.after)
        draws.push({
            equipment_id: equipmentId,
            treasure_up_type: effects.draws[index]?.treasureUpType ?? 0,
        })
    }
    return {
        draw: draws,
        characters: [],
        equipment: [...equipment.values()],
        items: {},
        isErupt: effects.isErupt,
    }
}

export function rewardGachaDrawResultThroughGrantOwnerSync(
    playerId: number,
    gacha: Gacha,
    drawResult: readonly number[],
    drawMetadata: readonly GachaDrawMetadata[] | undefined,
    characterMoviePlan: readonly PlannedCharacterGachaMovie[] | undefined,
    options: GachaRewardGrantOptions & { readonly ownerGrant: GachaRewardGrantOwner },
): RewardPlayerGachaDrawResult {
    const isCharacter = gacha.type === GachaType.CHARACTER
    if (isCharacter) {
        if (characterMoviePlan === undefined) {
            throw new GachaRewardGrantMismatchError("Character gacha movie plan is required")
        }
        assertCharacterMoviePlan(drawResult, characterMoviePlan)
        const plan = createPlan("character", drawResult)
        assertPlanMatchesDrawResult(plan, "character", drawResult)
        const grant = validateGrant(playerId, plan, options.ownerGrant(plan))
        return projectCharacters(
            playerId,
            grant,
            drawResult,
            characterMoviePlan,
            options.deferCharacterSampledLog,
        )
    }

    assertEquipmentMetadata(drawResult, drawMetadata)
    const movieInputs: EquipmentMovieDrawInput[] = drawMetadata.map(metadata => ({
        id: metadata.id,
        rank: metadata.rank,
        isGuarantee: metadata.isGuarantee,
    }))
    const effects = computeEquipmentGachaMovieEffectsForGacha(gacha, movieInputs)
    const plan = createPlan("equipment", drawResult)
    assertPlanMatchesDrawResult(plan, "equipment", drawResult)
    const grant = validateGrant(playerId, plan, options.ownerGrant(plan))
    return projectEquipment(grant, drawResult, effects)
}
