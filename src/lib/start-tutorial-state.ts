import { getDb } from "../data/db"
import { getPlayerSync } from "../data/domains/player"

export const TUTORIAL_GACHA_CHARACTER_IDS = [
    251001,
    251002,
    251003,
    251004,
    251005,
    251006,
    251007,
    251008,
] as const

export const SHORTENED_TUTORIAL_STEP_OFFSET = 11
export const TUTORIAL_GACHA_EFFECTIVE_STEP = 15
export const TUTORIAL_PRESENT_EFFECTIVE_STEP = 16
export const TUTORIAL_END_EFFECTIVE_STEP = 17

export function getTutorialEffectiveStep(step: number, skip: boolean | null): number {
    return step + (skip ? SHORTENED_TUTORIAL_STEP_OFFSET : 0)
}

export function getTutorialEffectiveNextStep(completedStep: number, skip: boolean): number {
    return getTutorialEffectiveStep(completedStep + 1, skip)
}

export function isStartTutorialActive(
    step: number | null,
    skip: boolean | null,
): boolean {
    return step !== null && getTutorialEffectiveStep(step, skip) < TUTORIAL_END_EFFECTIVE_STEP
}

export function reconcileInterruptedStartTutorialSync(playerId: number): void {
    const player = getPlayerSync(playerId)
    if (
        player === null
        || player.tutorialStep === null
        || player.tutorialGachaCharacterId !== null
        || getTutorialEffectiveStep(player.tutorialStep, player.tutorialSkipFlag)
            !== TUTORIAL_GACHA_EFFECTIVE_STEP
    ) {
        return
    }

    getDb().prepare(`
        UPDATE players
        SET tutorial_step = ?
        WHERE id = ?
          AND tutorial_step = ?
          AND tutorial_gacha_character_id IS NULL
    `).run(
        Math.max(0, player.tutorialStep - 1),
        playerId,
        player.tutorialStep,
    )
}
