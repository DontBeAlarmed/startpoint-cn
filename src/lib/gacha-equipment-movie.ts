import equipmentGachaMovieProbability from "../../assets/equipment_gacha_movie_probability.json"

export interface EquipmentMovieDrawInput {
    id: number
    rank: number
    isGuarantee: boolean
}

export interface EquipmentGachaMovieProbability {
    stringId: string
    probabilityEruption: number
    probabilityTreasureUp3To5: number
    probabilityTreasureUp4To5: number
    probabilityTreasureUp3To4: number
    guaranteeProbabilityTreasureUp3To5: number
    guaranteeProbabilityTreasureUp4To5: number
    guaranteeProbabilityTreasureUp3To4: number
}

export interface EquipmentMovieDrawResult {
    equipmentId: number
    treasureUpType: number
}

export interface EquipmentGachaMovieEffects {
    isErupt: boolean
    draws: EquipmentMovieDrawResult[]
}

type Roll = () => number

interface EquipmentMovieGachaConfig {
    equipmentMovieProbabilityId?: string
}

export function getEquipmentGachaMovieProbabilitySync(
    id: string | number | undefined
): EquipmentGachaMovieProbability | null {
    if (id === undefined) return null

    const table = equipmentGachaMovieProbability as Record<string, EquipmentGachaMovieProbability>
    return table[String(id)] ?? null
}

function treasureUpTargetRank(treasureUpType: number): number | null {
    switch (treasureUpType) {
        case 1:
        case 2:
            return 5
        case 3:
            return 4
        default:
            return null
    }
}

function treasureUpProbability(
    treasureUpType: number,
    probability: EquipmentGachaMovieProbability,
    isGuarantee: boolean
): number {
    switch (treasureUpType) {
        case 1:
            return isGuarantee
                ? probability.guaranteeProbabilityTreasureUp3To5
                : probability.probabilityTreasureUp3To5
        case 2:
            return isGuarantee
                ? probability.guaranteeProbabilityTreasureUp4To5
                : probability.probabilityTreasureUp4To5
        case 3:
            return isGuarantee
                ? probability.guaranteeProbabilityTreasureUp3To4
                : probability.probabilityTreasureUp3To4
        default:
            return 0
    }
}

export function drawEquipmentTreasureUpType(
    rank: number,
    probability: EquipmentGachaMovieProbability,
    isGuarantee: boolean,
    roll: Roll = Math.random
): number {
    for (const treasureUpType of [1, 2, 3]) {
        const targetRank = treasureUpTargetRank(treasureUpType)
        if (targetRank === rank) continue

        if (roll() <= treasureUpProbability(treasureUpType, probability, isGuarantee)) {
            return treasureUpType
        }
    }

    return 0
}

export function computeEquipmentGachaMovieEffects(
    drawInputs: EquipmentMovieDrawInput[],
    probability: EquipmentGachaMovieProbability,
    roll: Roll = Math.random
): EquipmentGachaMovieEffects {
    const hasRankFive = drawInputs.some((draw) => draw.rank === 5)
    const isErupt = hasRankFive ? roll() <= probability.probabilityEruption : false

    return {
        isErupt,
        draws: drawInputs.map((draw) => ({
            equipmentId: draw.id,
            treasureUpType: !isErupt && draw.rank > 3
                ? drawEquipmentTreasureUpType(draw.rank, probability, draw.isGuarantee, roll)
                : 0,
        })),
    }
}

export function computeEquipmentGachaMovieEffectsForGacha(
    gacha: EquipmentMovieGachaConfig,
    drawInputs: EquipmentMovieDrawInput[],
    roll: Roll = Math.random
): EquipmentGachaMovieEffects {
    const probability = getEquipmentGachaMovieProbabilitySync(gacha.equipmentMovieProbabilityId)
    if (!probability) {
        return {
            isErupt: false,
            draws: drawInputs.map((draw) => ({
                equipmentId: draw.id,
                treasureUpType: 0,
            })),
        }
    }

    return computeEquipmentGachaMovieEffects(drawInputs, probability, roll)
}
