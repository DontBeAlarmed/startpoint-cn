/**
 * Rebuild star_grain_shop.json from wf-assets-cn CDN source data.
 * Preserves manual date overrides while deriving rewards from CN master data.
 */
import * as fs from "fs";
import * as path from "path";

const CDN_SOURCE = path.resolve(__dirname, "../../wf-assets-cn/orderedmap/shop/star_grain_shop.json");
const OUTPUT = path.resolve(__dirname, "../assets/star_grain_shop.json");
const EXISTING = path.resolve(__dirname, "../assets/star_grain_shop.json"); // Use current as "existing"
const REWARD_SLOT_STARTS = [25, 28, 31, 34, 37, 40] as const;

interface ShopItem {
    costs: { id: number; amount: number }[];
    rewards: { type: number; id: number; count: number }[];
    availableFrom: string;
    availableUntil: string | null;
    stock: number;
    userCost?: { type: number; amount: number };
    shopCategoryId?: number;
    groupId?: number;
    stage?: number;
    equipmentId?: number;
    enhancementMaxLevel?: number;
}

type StarGrainShopData = Record<string, ShopItem>;

function parseInteger(value: string | undefined): number | null {
    if (value === undefined || !/^-?\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseRewardSlots(productId: string, raw: string[]): ShopItem["rewards"] {
    return REWARD_SLOT_STARTS.flatMap((slotStart) => {
        const values = raw.slice(slotStart, slotStart + 3);
        const isEmpty = values.length === 3
            && values.every((value) => value === "" || value === "(None)");
        if (isEmpty) return [];

        const [typeValue, idValue, countValue] = values;
        const type = parseInteger(typeValue);
        const id = parseInteger(idValue);
        const count = parseInteger(countValue);
        const isValid = type !== null && type >= 0 && type <= 4
            && id !== null && id > 0
            && count !== null && count > 0;
        if (!isValid) {
            throw new Error(
                `商品 ${productId} 奖励槽位 ${slotStart} 无效: `
                + `type=${String(typeValue)}, id=${String(idValue)}, count=${String(countValue)}`,
            );
        }
        return [{ type, id, count }];
    });
}

/**
 * CDN field indices (43-element array):
 * [0]=prefix, [1]=name, [10]=cost_item_id, [11]=cost_amount,
 * [18]=availableFrom, [19]=availableUntil, [20]=daily_limit,
 * [21]=stock(buy_max_count), [25..42]=six reward slots (type, id, count)
 */
function parseCdnEntry(productId: string, raw: string[]): ShopItem | null {
    const costItemId = parseInt(raw[10], 10);
    const costAmount = parseInt(raw[11], 10);
    const rewards = parseRewardSlots(productId, raw);
    const availableFrom = raw[18];
    const availableUntil = raw[19] === "(None)" || raw[19] === "" ? null : raw[19];
    const stock = parseInt(raw[21], 10) || 1;

    if (isNaN(costItemId) || isNaN(costAmount) || rewards.length === 0) return null;

    return {
        costs: [{ id: costItemId, amount: costAmount }],
        rewards,
        availableFrom,
        availableUntil,
        stock,
    };
}

function main() {
    // Load CDN data
    const cdnRaw = JSON.parse(fs.readFileSync(CDN_SOURCE, "utf-8"));
    const existingData: StarGrainShopData = fs.existsSync(EXISTING)
        ? JSON.parse(fs.readFileSync(EXISTING, "utf-8"))
        : {};

    const prevCount = Object.keys(existingData).length;
    console.log(`Existing server items: ${prevCount}`);

    const newData: StarGrainShopData = {};
    let cdnCount = 0;
    let addedCount = 0;
    let updatedCount = 0;

    for (const [key, arr] of Object.entries(cdnRaw)) {
        if (key === "9999") continue;
        if (!Array.isArray(arr) || arr.length === 0) continue;
        const raw = arr[0];
        if (!Array.isArray(raw)) continue;

        const cdnItem = parseCdnEntry(key, raw);
        if (!cdnItem) continue;
        cdnCount++;

        // Check if item exists in server data
        const existingItem = existingData[key];

        if (existingItem) {
            // Update from CN master data, but keep user-edited dates.
            newData[key] = {
                ...cdnItem,
                availableFrom: existingItem.availableFrom !== cdnItem.availableFrom
                    ? existingItem.availableFrom : cdnItem.availableFrom,
                availableUntil: existingItem.availableUntil !== null
                    ? existingItem.availableUntil : cdnItem.availableUntil,
            };
            const oldRewards = JSON.stringify(existingItem.rewards);
            const newRewards = JSON.stringify(cdnItem.rewards);
            if (oldRewards !== newRewards || existingItem.costs[0].amount !== cdnItem.costs[0].amount) {
                updatedCount++;
                console.log(`  ${key}: UPDATED rewards ${oldRewards} → ${newRewards} cost ${existingItem.costs[0].amount} → ${cdnItem.costs[0].amount}`);
            } else {
                console.log(`  ${key}: unchanged`);
            }
        } else {
            // New item from CDN
            newData[key] = cdnItem;
            addedCount++;
            console.log(`  ${key}: NEW — ${raw[1]} → ${cdnItem.rewards.map(r => `${r.type}:${r.id}`).join(',')}`);
        }
    }

    const droppedCount = Object.keys(existingData)
        .filter((key) => newData[key] === undefined)
        .length;

    // Stats
    const totalCount = Object.keys(newData).length;
    console.log(`\n=== Summary ===`);
    console.log(`CDN source items: ${cdnCount}`);
    console.log(`Previous server items: ${prevCount}`);
    console.log(`New items: ${totalCount}`);
    console.log(`  Updated: ${updatedCount}`);
    console.log(`  Added (from CDN): ${addedCount}`);
    console.log(`  Dropped (no valid CN source): ${droppedCount}`);

    fs.writeFileSync(OUTPUT, JSON.stringify(newData, null, 2));
    console.log(`\nWritten: ${OUTPUT}`);
}

if (require.main === module) main();
