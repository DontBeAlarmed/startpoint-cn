import { getDefaultGachaSeedQuarantine } from "../gacha-seed-quarantine"
import { formatGachaCharacterDrawsSummary } from "../hot-path-log-formatters"
import { sampledLog } from "../sampled-log"
import type { GachaExchangeSuccess, GachaExecSuccess, GachaPostCommitResult } from "./model"

export interface GachaPostCommitDependencies {
    readonly markSeed?: (movieId: string, seed: number, rarity: number) => void
    readonly sampledCharacterLog?: (result: Extract<
        GachaExecSuccess["postCommitEffects"][number],
        { readonly kind: "sampledLog" }
    >) => void
    readonly publishGrowth: (
        playerId: number,
        characterIds: readonly number[],
        characters: readonly Record<string, unknown>[],
        source: "gacha/exec" | "gacha/exchange_character",
    ) => readonly Record<string, unknown>[]
}

const defaultMarkSeed = (movieId: string, seed: number, rarity: number) => {
        getDefaultGachaSeedQuarantine().markSent(movieId, seed, rarity)
}
const defaultSampledCharacterLog = (effect: Extract<
    GachaExecSuccess["postCommitEffects"][number],
    { readonly kind: "sampledLog" }
>) => {
        sampledLog("gacha-character-draws", () => formatGachaCharacterDrawsSummary(effect))
}

export function runGachaPostCommitEffects(
    result: GachaExecSuccess | GachaExchangeSuccess,
    dependencies: GachaPostCommitDependencies,
): GachaPostCommitResult {
    let characterList = result.kind === "character" ? result.characters : []
    for (const effect of result.postCommitEffects) {
        try {
            if (effect.kind === "seedMark") {
                ;(dependencies.markSeed ?? defaultMarkSeed)(
                    effect.movieId,
                    effect.seed,
                    effect.rarity,
                )
            } else if (effect.kind === "sampledLog") {
                ;(dependencies.sampledCharacterLog ?? defaultSampledCharacterLog)(effect)
            } else {
                characterList = dependencies.publishGrowth(
                    effect.playerId,
                    effect.characterIds,
                    effect.characters,
                    effect.source,
                )
            }
        } catch {
            console.error(`[GACHA] post_commit_effect_failed kind=${effect.kind}`)
        }
    }
    return { characterList }
}
