import { parseShopCnTimestamp } from "./event-shop-purchase"
import type {
    ShopItem,
    ShopSelectItemCampaign,
    ShopSelectItemCampaigns,
} from "./types/shop"

export const SHOP_CAMPAIGN_PERIOD_ERROR_CODE = 1652

export class ShopCampaignValidationError extends Error {}

export class ShopCampaignPeriodError extends Error {
    readonly resultCode = SHOP_CAMPAIGN_PERIOD_ERROR_CODE
}

export function requireAvailableShopCampaign(
    campaigns: Readonly<ShopSelectItemCampaigns>,
    shopType: number,
    campaignId: number,
    lineupId: number | null,
    nowMs: number,
): Readonly<ShopSelectItemCampaign> {
    if ((shopType !== 4 && shopType !== 7)
        || !Number.isSafeInteger(campaignId) || campaignId <= 0
        || !Number.isFinite(nowMs)) {
        throw new ShopCampaignValidationError("Invalid shop campaign request.")
    }
    const campaign = campaigns[String(shopType)]?.[String(campaignId)]
    if (campaign === undefined) {
        throw new ShopCampaignValidationError("Shop campaign does not exist.")
    }
    const availableFrom = parseShopCnTimestamp(campaign.availableFrom)
    const availableUntil = parseShopCnTimestamp(campaign.availableUntil)
    if (nowMs < availableFrom || nowMs > availableUntil) {
        throw new ShopCampaignPeriodError("Shop campaign is outside its available period.")
    }
    if (lineupId !== null && (
        !Number.isSafeInteger(lineupId)
        || lineupId <= 0
        || !campaign.lineupIds.includes(lineupId)
    )) {
        throw new ShopCampaignValidationError("Shop campaign lineup does not exist.")
    }
    return campaign
}

export function isShopItemVisibleForCampaign(
    item: Pick<ShopItem, "campaignId" | "lineupId">,
    shopType: number,
    selections: Readonly<Record<string, number>>,
): boolean {
    if (item.campaignId === undefined && item.lineupId === undefined) return true
    if (!Number.isSafeInteger(item.campaignId) || item.campaignId! <= 0) return false
    if (item.lineupId === undefined) return true
    if (!Number.isSafeInteger(item.lineupId) || item.lineupId <= 0) return false
    return selections[`${shopType}:${item.campaignId}`] === item.lineupId
}
