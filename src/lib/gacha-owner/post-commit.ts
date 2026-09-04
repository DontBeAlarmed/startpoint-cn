import { publishCharacterGrowthOwnerStateBestEffort } from "../character-growth/owner-publication"
import { getDefaultGachaSeedQuarantine } from "../gacha-seed-quarantine"
import { formatGachaCharacterDrawsSummary } from "../hot-path-log-formatters"
import { sampledLog } from "../sampled-log"
import type { GachaExecSuccess, GachaPostCommitResult } from "./model"

export interface GachaPostCommitDependencies {
    readonly markSeed: (movieId: string, seed: number, rarity: number) => void
    readonly sampledCharacterLog: (result: Extract<
        GachaExecSuccess["postCommitEffects"][number],
        { readonly kind: "sampledLog" }
    >) => void
    readonly publishGrowth: (
        playerId: number,
        characters: readonly Record<string, unknown>[],
    ) => readonly Record<string, unknown>[]
}

const defaultDependencies: GachaPostCommitDependencies = {
    markSeed: (movieId, seed, rarity) => {
        getDefaultGachaSeedQuarantine().markSent(movieId, seed, rarity)
    },
    sampledCharacterLog: effect => {
        sampledLog("gacha-character-draws", () => formatGachaCharacterDrawsSummary(effect))
    },
    publishGrowth: (playerId, characters) => publishCharacterGrowthOwnerStateBestEffort(
        playerId,
        [],
        [[...characters]],
        {},
        "gacha/exec",
    ).characterList,
}

export function runGachaPostCommitEffects(
    result: GachaExecSuccess,
    dependencies: GachaPostCommitDependencies = defaultDependencies,
): GachaPostCommitResult {
    let characterList = result.kind === "character" ? result.characters : []
    for (const effect of result.postCommitEffects) {
        try {
            if (effect.kind === "seedMark") {
                dependencies.markSeed(effect.movieId, effect.seed, effect.rarity)
            } else if (effect.kind === "sampledLog") {
                dependencies.sampledCharacterLog(effect)
            } else {
                characterList = dependencies.publishGrowth(
                    effect.playerId,
                    effect.characters,
                )
            }
        } catch {
            console.error(`[GACHA] post_commit_effect_failed kind=${effect.kind}`)
        }
    }
    return { characterList }
}
