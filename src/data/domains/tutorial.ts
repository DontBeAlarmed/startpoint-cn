import { getDb } from "../db";
import { RawPlayerTriggeredTutorial } from "../types";

export interface TutorialStepReceipt {
    completedStep: number
    skip: boolean
    responseData: Record<string, unknown>
}

interface RawTutorialStepReceipt {
    completed_step: number
    skip: number
    response_data: string
}

/**
 * Gets a player's triggered tutorials.
 * 
 * @param playerId The ID of the player to get the triggered tutorials of.
 * @returns A list of the IDs of each triggered tutorial.
 */
export function getPlayerTriggeredTutorialsSync(
    playerId: number
): number[] {
    const db = getDb();
    const raw = db.prepare(`
    SELECT id
    FROM players_triggered_tutorials
    WHERE player_id = ?
    `).all(playerId) as RawPlayerTriggeredTutorial[]

    return raw.map(rawTrigger => rawTrigger.id)
}

/**
 * Marks a tutorial as having been triggered by a player.
 * 
 * @param playerId The ID of the player that triggered the tutorial.
 * @param tutorialId The ID of the tutorial that was triggered.
 */
export function insertPlayerTriggeredTutorialSync(
    playerId: number,
    tutorialId: number
) {
    const db = getDb();
    db.prepare(`
    INSERT INTO players_triggered_tutorials (id, player_id)
    VALUES (?, ?)
    `).run(tutorialId, playerId)
}

/**
 * Batch marks tutorials as having been triggered by a player.
 * 
 * @param playerId The ID of the player that triggered the tutorials.
 * @param tutorialIds An array of tutorial IDs which were triggered.
 */
export function insertPlayerTriggeredTutorialsSync(
    playerId: number,
    tutorialIds: number[]
) {
    const db = getDb();
    db.transaction(() => {
        for (const tutorialId of tutorialIds) {
            insertPlayerTriggeredTutorialSync(playerId, tutorialId)
        }
    })()
}

export function getTutorialStepReceiptSync(
    playerId: number,
): TutorialStepReceipt | null {
    const raw = getDb().prepare(`
        SELECT completed_step, skip, response_data
        FROM players_tutorial_step_receipts
        WHERE player_id = ?
    `).get(playerId) as RawTutorialStepReceipt | undefined
    if (raw === undefined) return null

    return {
        completedStep: raw.completed_step,
        skip: raw.skip !== 0,
        responseData: JSON.parse(raw.response_data) as Record<string, unknown>,
    }
}

export function upsertTutorialStepReceiptSync(
    playerId: number,
    receipt: TutorialStepReceipt,
): void {
    getDb().prepare(`
        INSERT INTO players_tutorial_step_receipts (
            player_id, completed_step, skip, response_data
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(player_id) DO UPDATE SET
            completed_step = excluded.completed_step,
            skip = excluded.skip,
            response_data = excluded.response_data
    `).run(
        playerId,
        receipt.completedStep,
        receipt.skip ? 1 : 0,
        JSON.stringify(receipt.responseData),
    )
}
