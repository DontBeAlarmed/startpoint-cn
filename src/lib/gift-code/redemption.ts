import { getDb } from "../../data/db"
import { insertReceiveHistorySync } from "../../data/domains/mail"
import {
    collectRewardGrantItemOverflowDispositions,
    createRewardGrantExecutionPlan,
    executeRewardGrantExecutionPlanWithinTransactionSync,
    type RewardGrantCommand,
} from "../reward-grant"
import { createRewardGrantItemOverflowPolicy } from "../reward-grant-item-overflow"
import { getRealNow } from "../../runtime/time/game-time"
import { GIFT_TO_REWARD_TYPE, validateGiftCode, validateGiftRewards } from "./validation"
import type { GiftReceiveResult, GiftReward } from "./types"

interface GiftRedemptionRow {
    readonly id: unknown
    readonly status: unknown
}

interface GiftAuthorityRow {
    readonly revision: unknown
    readonly rewardRevision: unknown
}

function invalid(): GiftReceiveResult {
    return { resultCode: 6101, rewards: [] }
}

function stopped(): GiftReceiveResult {
    return { resultCode: 6103, rewards: [] }
}

function duplicate(): GiftReceiveResult {
    return { resultCode: 6104, rewards: [] }
}

function isRedemptionUniqueConflict(error: unknown): boolean {
    return typeof error === "object" && error !== null
        && (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_PRIMARYKEY"
}

function requireGiftInteger(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} is invalid`)
    }
    return value
}

function toRewardGrantCommand(reward: GiftReward): RewardGrantCommand {
    switch (reward.type) {
        case 1:
        case 6:
            return {
                type: GIFT_TO_REWARD_TYPE[reward.type],
                id: reward.typeId as number,
                count: reward.number,
            }
        case 5:
            return { type: GIFT_TO_REWARD_TYPE[reward.type], id: reward.typeId as number }
        case 4:
        case 8:
        case 9:
            return { type: GIFT_TO_REWARD_TYPE[reward.type], count: reward.number }
    }
}

export function receiveGiftCodeSync(playerId: number, rawKey: unknown): GiftReceiveResult {
    if (!Number.isSafeInteger(playerId) || playerId < 1) {
        throw new TypeError("playerId must be a positive integer")
    }
    if (typeof rawKey !== "string") return invalid()
    try {
        validateGiftCode(rawKey)
    } catch {
        return invalid()
    }

    const database = getDb()
    return database.transaction((): GiftReceiveResult => {
        const gift = database.prepare(`
            SELECT id, status
            FROM server_gift_codes
            WHERE code = ?
        `).get(rawKey) as GiftRedemptionRow | undefined
        if (gift === undefined) return invalid()
        const giftId = requireGiftInteger(gift.id, "Gift ID")
        if (gift.status !== "active") return stopped()

        const existing = database.prepare(`
            SELECT 1
            FROM players_gift_redemptions
            WHERE gift_id = ? AND player_id = ?
        `).get(giftId, playerId)
        if (existing !== undefined) return duplicate()

        const authority = database.prepare(`
            SELECT revision, reward_revision AS rewardRevision
            FROM server_gift_codes
            WHERE id = ? AND status = 'active'
        `).get(giftId) as GiftAuthorityRow | undefined
        if (authority === undefined) return stopped()
        requireGiftInteger(authority.revision, "Gift revision")
        const rewardRevision = requireGiftInteger(
            authority.rewardRevision,
            "Gift reward revision",
        )

        const rewards = database.prepare(`
            SELECT position, type, type_id AS typeId, number
            FROM server_gift_rewards
            WHERE gift_id = ?
            ORDER BY position
        `).all(giftId) as GiftReward[]
        validateGiftRewards(rewards)

        const snapshot = JSON.stringify(rewards.map(reward => ({
            position: reward.position,
            type: reward.type,
            type_id: reward.typeId,
            number: reward.number,
        })))
        try {
            database.prepare(`
                INSERT INTO players_gift_redemptions (
                    gift_id, player_id, reward_revision, reward_snapshot, redeemed_at
                ) VALUES (?, ?, ?, ?, ?)
            `).run(
                giftId,
                playerId,
                rewardRevision,
                snapshot,
                getRealNow().toISOString(),
            )
        } catch (error) {
            if (isRedemptionUniqueConflict(error)) return duplicate()
            throw error
        }

        const plan = createRewardGrantExecutionPlan(rewards.map(toRewardGrantCommand))
        const grant = executeRewardGrantExecutionPlanWithinTransactionSync(
            playerId,
            plan,
            { itemOverflow: createRewardGrantItemOverflowPolicy(playerId) },
        )

        for (const reward of rewards) {
            insertReceiveHistorySync(playerId, {
                type: reward.type,
                type_id: reward.typeId,
                number: reward.number,
            })
        }

        const dispositions = collectRewardGrantItemOverflowDispositions(grant)
        return {
            // CN 1.8.1 MenuTopScene.RC_GIFT_KEY_OK = 1: successGiftHandler only
            // opens the reward dialog when the body result_code is exactly 1;
            // any other value (including 0) is shown as a gift error.
            resultCode: 1,
            rewards,
            ...(dispositions.length === 0
                ? {}
                : {
                    itemOverflow: Object.freeze({
                        dispositions,
                        itemList: Object.freeze(Object.fromEntries(
                            grant.assets.items.map(item => [String(item.itemId), item.afterAmount]),
                        )),
                        freeManaAfter: dispositions.some(disposition => disposition.kind === "sold")
                            ? grant.playerAfter.freeMana
                            : null,
                    }),
                }),
        }
    })()
}
