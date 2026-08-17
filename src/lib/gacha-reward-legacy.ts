import { getPlayerItemSync } from "../data/domains/item"
import { givePlayerCharacterSync } from "./character"
import { givePlayerEquipmentSync } from "./equipment"
import {
    computeEquipmentGachaMovieEffectsForGacha,
    type EquipmentMovieDrawInput,
} from "./gacha-equipment-movie"
import type { GachaDrawMetadata } from "./gacha-draw"
import { getDefaultGachaSeedQuarantine } from "./gacha-seed-quarantine"
import type { PlannedCharacterGachaMovie } from "./gacha-reward-grant"
import { formatGachaCharacterDrawsSummary } from "./hot-path-log-formatters"
import { sampledLog } from "./sampled-log"
import type {
    Gacha,
    GachaCharacterDraw,
    GachaDraws,
    RewardPlayerGachaDrawResult,
} from "./types"
import { GachaType } from "./types"

const gachaSeedQuarantine = getDefaultGachaSeedQuarantine()

export function rewardPlayerGachaDrawResultLegacySync(
    playerId: number,
    gacha: Gacha,
    gachaDrawResult: number[],
    gachaDrawMetadata: GachaDrawMetadata[] | undefined,
    characterMoviePlan: PlannedCharacterGachaMovie[] | undefined,
): RewardPlayerGachaDrawResult {
    const draws: GachaDraws = []
    const characters: Map<number, Object> = new Map()
    const equipment: Map<number, Object> = new Map()
    const items: Map<number, number> = new Map()

    if (gacha.type === GachaType.CHARACTER) {
        if (characterMoviePlan === undefined
            || characterMoviePlan.length !== gachaDrawResult.length
            || characterMoviePlan.some((plan, index) =>
                plan.characterId !== gachaDrawResult[index])) {
            throw new Error("Character gacha movie plan does not match draw result")
        }
        for (let index = 0; index < gachaDrawResult.length; index += 1) {
            const characterId = gachaDrawResult[index]
            const plannedMovie = characterMoviePlan[index]
            const giveResult = givePlayerCharacterSync(playerId, characterId)

            if (giveResult !== null) {
                const { rarity, movieId, seed } = plannedMovie
                if (!plannedMovie.requiresVerification) {
                    const draw: GachaCharacterDraw = {
                        character_id: characterId,
                        movie_id: movieId,
                        seed,
                        entry_count: 1,
                    }
                    draws.push(draw)
                    characters.set(characterId, giveResult.character)
                    continue
                }

                gachaSeedQuarantine.markSent(movieId, seed, rarity)
                const draw: GachaCharacterDraw = {
                    character_id: characterId,
                    movie_id: movieId,
                    seed,
                    entry_count: 1,
                }
                const giveItem = giveResult.item
                if (giveItem !== undefined) {
                    draw.ex_boost_item = giveItem
                    items.set(giveItem.id, getPlayerItemSync(playerId, giveItem.id) ?? 0)
                }

                const existingCharacter = characters.get(characterId)
                characters.set(characterId, existingCharacter
                    ? { ...existingCharacter, ...giveResult.character }
                    : giveResult.character)
                draws.push(draw)
            }
        }

        sampledLog("gacha-character-draws", () => formatGachaCharacterDrawsSummary({
            playerId,
            draws: draws as GachaCharacterDraw[],
            moviePlans: characterMoviePlan,
        }))
    } else {
        const equipmentMovieInputs: EquipmentMovieDrawInput[] = gachaDrawResult.map(
            (equipmentId, index) => {
                const metadata = gachaDrawMetadata?.[index]
                return {
                    id: equipmentId,
                    rank: metadata?.rank ?? 0,
                    isGuarantee: metadata?.isGuarantee ?? false,
                }
            },
        )
        const equipmentMovieEffects = computeEquipmentGachaMovieEffectsForGacha(
            gacha,
            equipmentMovieInputs,
        )

        for (let index = 0; index < gachaDrawResult.length; index += 1) {
            const equipmentId = gachaDrawResult[index]
            const giveResult = givePlayerEquipmentSync(playerId, equipmentId, 1)
            equipment.set(equipmentId, giveResult)
            draws.push({
                equipment_id: equipmentId,
                treasure_up_type: equipmentMovieEffects.draws[index]?.treasureUpType ?? 0,
            })
        }

        return {
            draw: draws,
            characters: [],
            equipment: Array.from(equipment.values()),
            items: Object.fromEntries(items),
            isErupt: equipmentMovieEffects.isErupt,
        }
    }

    return {
        draw: draws,
        characters: Array.from(characters.values()),
        equipment: Array.from(equipment.values()),
        items: Object.fromEntries(items),
    }
}
