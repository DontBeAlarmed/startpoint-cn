import { createRewardGrantPlan } from "./reward-grant"
import type { RewardGrantPlan } from "./reward-grant"
import type { InternalRewardGrantResult } from "./reward-grant/entry-result"
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

export interface GachaRewardSource {
    readonly drawIndex: number
    readonly kind: "character" | "equipment"
    readonly rewardId: number
}
export type GachaRewardGrantOwner = (
    plan: RewardGrantPlan<GachaRewardSource>,
) => InternalRewardGrantResult<GachaRewardSource>

export interface GachaRewardGrantOptions {
    readonly ownerGrant?: GachaRewardGrantOwner
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
    kind: GachaRewardSource["kind"],
    drawResult: readonly number[],
): RewardGrantPlan<GachaRewardSource> {
    const rewardType = kind === "character" ? RewardType.CHARACTER : RewardType.EQUIPMENT
    return createRewardGrantPlan(drawResult.map((rewardId, drawIndex) => ({
        source: { drawIndex, kind, rewardId },
        reward: kind === "character"
            ? { type: rewardType as RewardType.CHARACTER, id: rewardId }
            : { type: rewardType as RewardType.EQUIPMENT, id: rewardId, count: 1 },
    })))
}

function assertPlanMatchesDrawResult(
    plan: RewardGrantPlan<GachaRewardSource>,
    kind: GachaRewardSource["kind"],
    drawResult: readonly number[],
): void {
    if (plan.entries.length !== drawResult.length) {
        throw new GachaRewardGrantMismatchError("Gacha reward plan length does not match draw result")
    }
    for (let index = 0; index < drawResult.length; index += 1) {
        const entry = plan.entries[index]
        if (entry.source.drawIndex !== index
            || entry.source.kind !== kind
            || entry.source.rewardId !== drawResult[index]
            || !("id" in entry.reward)
            || entry.reward.id !== drawResult[index]) {
            throw new GachaRewardGrantMismatchError(
                `Gacha reward plan source at index ${index} does not match draw result`,
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

function assertGrantMatchesPlan(
    plan: RewardGrantPlan<GachaRewardSource>,
    grant: InternalRewardGrantResult<GachaRewardSource>,
): void {
    if (grant.entries.length !== plan.entries.length) {
        throw new GachaRewardGrantMismatchError("Gacha reward entry count does not match plan")
    }
    for (let index = 0; index < plan.entries.length; index += 1) {
        const expected = plan.entries[index]
        const actual = grant.entries[index]
        const source = actual?.source
        if (source?.drawIndex !== index
            || source.kind !== expected.source.kind
            || source.rewardId !== expected.source.rewardId
            || actual.reward.type !== expected.reward.type
            || !("id" in actual.reward)
            || !("id" in expected.reward)
            || actual.reward.id !== expected.reward.id) {
            throw new GachaRewardGrantMismatchError(
                `Gacha reward source at index ${index} does not match draw result`,
            )
        }
    }
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
    grant: InternalRewardGrantResult<GachaRewardSource>,
    moviePlan: readonly PlannedCharacterGachaMovie[],
    deferLog: GachaRewardGrantOptions["deferCharacterSampledLog"],
): RewardPlayerGachaDrawResult {
    const draws: GachaCharacterDraw[] = []
    const characters = new Map<number, Object>()
    const items: Record<number, number> = {}

    for (let index = 0; index < grant.entries.length; index += 1) {
        const entry = grant.entries[index]
        const plannedMovie = moviePlan[index]
        if (entry.result.character_list.length !== 1) {
            throw new GachaRewardGrantMismatchError(
                `Character gacha reward result at index ${index} is invalid`,
            )
        }
        const characterId = entry.source.rewardId
        const character = entry.result.character_list[0]
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
        const itemDeltas = Object.entries(entry.itemDeltas ?? {})
        if (itemDeltas.length > 1) {
            throw new GachaRewardGrantMismatchError(
                `Character gacha compensation at index ${index} is invalid`,
            )
        }
        if (itemDeltas.length === 1) {
            const [itemIdText, count] = itemDeltas[0]
            const itemId = Number(itemIdText)
            const finalCount = entry.result.items[itemId]
            if (!Number.isSafeInteger(itemId) || finalCount === undefined) {
                throw new GachaRewardGrantMismatchError(
                    `Character gacha compensation at index ${index} is invalid`,
                )
            }
            draw.ex_boost_item = { id: itemId, count }
            items[itemId] = finalCount
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
    grant: InternalRewardGrantResult<GachaRewardSource>,
    effects: ReturnType<typeof computeEquipmentGachaMovieEffectsForGacha>,
): RewardPlayerGachaDrawResult {
    const draws: GachaDraws = []
    const equipment = new Map<number, Object>()
    for (let index = 0; index < grant.entries.length; index += 1) {
        const entry = grant.entries[index]
        if (entry.result.equipment_list.length !== 1) {
            throw new GachaRewardGrantMismatchError(
                `Equipment gacha reward result at index ${index} is invalid`,
            )
        }
        const equipmentId = entry.source.rewardId
        equipment.set(equipmentId, entry.result.equipment_list[0])
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
        const grant = options.ownerGrant(plan)
        assertGrantMatchesPlan(plan, grant)
        return projectCharacters(
            playerId,
            grant,
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
    const grant = options.ownerGrant(plan)
    assertGrantMatchesPlan(plan, grant)
    return projectEquipment(grant, effects)
}
