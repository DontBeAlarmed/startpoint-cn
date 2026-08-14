import type { DropScoreRewardId, GachaCharacterDraw } from "./types"

interface QuestScoreRewardsSummaryInput {
    playerId: number
    groupId: number
    commonDrops: readonly DropScoreRewardId[]
    rareDrops: readonly DropScoreRewardId[]
    inventoryTotals: Readonly<Record<string, number>>
}

interface CharacterMoviePlanSummaryInput {
    characterId: number
    movieId: string
    seed: number
    rarity: number
    requiresVerification: boolean
}

interface GachaCharacterDrawsSummaryInput {
    playerId: number
    draws: readonly GachaCharacterDraw[]
    moviePlans: readonly CharacterMoviePlanSummaryInput[]
}

export function formatQuestScoreRewardsSummary(
    input: QuestScoreRewardsSummaryInput,
): string {
    const drops = input.commonDrops.map(({ index, number }) => ({ index, number }))
    const rareDrops = input.rareDrops.map(({ group_id, index, number }) => ({
        group_id,
        index,
        number,
    }))
    return `[QUEST] score_rewards playerId=${input.playerId} groupId=${input.groupId}`
        + ` common=${input.commonDrops.length} rare=${input.rareDrops.length}`
        + ` drops=${JSON.stringify(drops)} rareDrops=${JSON.stringify(rareDrops)}`
        + ` inventoryTotals=${JSON.stringify(input.inventoryTotals)}`
}

export function formatGachaCharacterDrawsSummary(
    input: GachaCharacterDrawsSummaryInput,
): string {
    const characters = input.draws.map(draw => {
        const plan = input.moviePlans.find(candidate =>
            candidate.characterId === draw.character_id
            && candidate.movieId === draw.movie_id
            && candidate.seed === draw.seed
        )
        return {
            character_id: draw.character_id,
            movie_id: draw.movie_id,
            seed: draw.seed,
            rarity: plan?.rarity,
            verification: plan?.requiresVerification === false ? "SKIP" : "VERIFY",
        }
    })
    return `[GACHA] reward_summary playerId=${input.playerId} draws=${input.draws.length}`
        + ` characters=${JSON.stringify(characters)}`
}
