/**
 * Rebuild star_grain_shop.json from wf-assets-cn CDN source data.
 * Preserves manually-expanded rewards for 套装/培育素材箱 items.
 */
import * as fs from "fs";
import * as path from "path";

const CDN_SOURCE = path.resolve(__dirname, "../../wf-assets-cn/orderedmap/shop/star_grain_shop.json");
const OUTPUT = path.resolve(__dirname, "../assets/star_grain_shop.json");
const EXISTING = path.resolve(__dirname, "../assets/star_grain_shop.json"); // Use current as "existing"

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

/**
 * CDN field indices (43-element array):
 * [0]=prefix, [1]=name, [10]=cost_item_id, [11]=cost_amount,
 * [18]=availableFrom, [19]=availableUntil, [20]=daily_limit,
 * [21]=stock(buy_max_count), [25]=kind1_type, [26]=kind1_id, [27]=kind1_count
 */
function parseCdnEntry(raw: string[]): ShopItem | null {
    const costItemId = parseInt(raw[10], 10);
    const costAmount = parseInt(raw[11], 10);
    const rewardType = raw[25] !== "(None)" && raw[25] ? parseInt(raw[25], 10) : -1;
    const rewardId = raw[26] !== "(None)" && raw[26] ? parseInt(raw[26], 10) : 0;
    const rewardCount = raw[27] !== "(None)" && raw[27] ? parseInt(raw[27], 10) : 1;
    const availableFrom = raw[18];
    const availableUntil = raw[19] === "(None)" || raw[19] === "" ? null : raw[19];
    const stock = parseInt(raw[21], 10) || 1;

    if (isNaN(costItemId) || isNaN(costAmount) || rewardType < 0 || rewardId === 0) return null;

    return {
        costs: [{ id: costItemId, amount: costAmount }],
        rewards: [{ type: rewardType, id: rewardId, count: rewardCount }],
        availableFrom,
        availableUntil,
        stock,
    };
}

function hasExpandedRewards(item: ShopItem): boolean {
    return item.rewards.length > 1;
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
    let preservedCount = 0;
    let updatedCount = 0;
    const uncheckedExisting = new Set(Object.keys(existingData));

    for (const [key, arr] of Object.entries(cdnRaw)) {
        if (key === "9999") continue;
        if (!Array.isArray(arr) || arr.length === 0) continue;
        const raw = arr[0];
        if (!Array.isArray(raw) || raw.length < 28) continue;

        const cdnItem = parseCdnEntry(raw);
        if (!cdnItem) continue;
        cdnCount++;

        // Check if item exists in server data
        const existingItem = existingData[key];

        if (existingItem && hasExpandedRewards(existingItem)) {
            // Preserve manually-expanded rewards (套装/培育素材箱 etc.)
            // but update costs, dates, stock from CDN
            newData[key] = {
                ...existingItem,
                costs: cdnItem.costs,
                availableFrom: existingItem.availableFrom !== cdnItem.availableFrom
                    ? existingItem.availableFrom : cdnItem.availableFrom,
                availableUntil: existingItem.availableUntil !== null
                    ? existingItem.availableUntil : cdnItem.availableUntil,
                stock: cdnItem.stock,
            };
            preservedCount++;
            uncheckedExisting.delete(key);
            console.log(`  ${key}: PRESERVED (expanded rewards, ${existingItem.rewards.length} rewards)`);
        } else if (existingItem) {
            // Regular item: update from CDN, but keep user-edited dates
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
            uncheckedExisting.delete(key);
        } else {
            // New item from CDN
            newData[key] = cdnItem;
            addedCount++;
            console.log(`  ${key}: NEW — ${raw[1]} → ${cdnItem.rewards.map(r => `${r.type}:${r.id}`).join(',')}`);
        }
    }

    // Add orphaned server items that don't exist in CDN
    let orphanCount = 0;
    for (const key of uncheckedExisting) {
        newData[key] = existingData[key];
        orphanCount++;
        console.log(`  ${key}: ORPHAN (not in CDN, kept as-is)`);
    }

    // Stats
    const totalCount = Object.keys(newData).length;
    console.log(`\n=== Summary ===`);
    console.log(`CDN source items: ${cdnCount}`);
    console.log(`Previous server items: ${prevCount}`);
    console.log(`New items: ${totalCount}`);
    console.log(`  Updated: ${updatedCount}`);
    console.log(`  Added (from CDN): ${addedCount}`);
    console.log(`  Preserved (expanded): ${preservedCount}`);
    console.log(`  Orphans (kept): ${orphanCount}`);

    fs.writeFileSync(OUTPUT, JSON.stringify(newData, null, 2));
    console.log(`\nWritten: ${OUTPUT}`);
}

main();
