/**
 * Rebuild boss_coin_shop.json and boss_coin_shop_item_category_map.json
 * from wf-assets-cn source data, keeping existing items (with modified dates)
 * and adding items for new categories (34-39, 51-58, 60-66, 70-71).
 */
import * as fs from "fs";
import * as path from "path";

const WF_ASSETS_CN = path.resolve(__dirname, "../../wf-assets-cn/orderedmap/shop/boss_coin_shop.json");
const OUTPUT_SHOP = path.resolve(__dirname, "../assets/boss_coin_shop.json");
const OUTPUT_CATMAP = path.resolve(__dirname, "../assets/boss_coin_shop_item_category_map.json");
const EXISTING = path.resolve(__dirname, "../assets/boss_coin_shop_existing.json");

interface ShopItem {
    costs: { id: number; amount: number }[];
    rewards: { type: number; id: number; count: number }[];
    availableFrom: string;
    availableUntil: string | null;
    stock: number;
}

type BossCoinShopData = Record<string, Record<string, ShopItem>>;
type CatMap = Record<string, number>;

// Parse wf-assets-cn flat array format
function parseWfBossCoinItem(raw: string[]): ShopItem | null {
    const catId = raw[0];
    const itemId = raw[7];  // Actually the primary key is the outer key
    const costItemId = parseInt(raw[17], 10);
    const costAmount = parseInt(raw[18], 10);
    const availableFrom = raw[25];
    const availableUntil = raw[26];
    const stock = parseInt(raw[27], 10) || 1;
    const rewardType = parseInt(raw[32], 10);
    const rewardId = parseInt(raw[33], 10);
    const rewardCount = parseInt(raw[34], 10) || 1;

    if (isNaN(costItemId) || isNaN(rewardId)) return null;

    return {
        costs: [{ id: costItemId, amount: costAmount }],
        rewards: [{ type: rewardType, id: rewardId, count: rewardCount }],
        availableFrom,
        availableUntil: availableUntil === "(None)" || availableUntil === "" ? null : availableUntil,
        stock,
    };
}

function main() {
    // Load wf-assets-cn data
    const wfData = JSON.parse(fs.readFileSync(WF_ASSETS_CN, "utf-8")) as Record<string, string[][]>;
    console.log(`wf-assets-cn entries: ${Object.keys(wfData).length}`);

    // Load existing starpoint-cn data (if exists)
    let existingData: BossCoinShopData = {};
    if (fs.existsSync(EXISTING)) {
        existingData = JSON.parse(fs.readFileSync(EXISTING, "utf-8"));
    } else if (fs.existsSync(OUTPUT_SHOP)) {
        existingData = JSON.parse(fs.readFileSync(OUTPUT_SHOP, "utf-8"));
    }
    console.log(`Existing starpoint-cn categories: ${Object.keys(existingData).length}`);
    console.log(`Existing starpoint-cn total items: ${
        Object.values(existingData).reduce((sum, items) => sum + Object.keys(items).length, 0)
    }`);

    // Build new data: for each wf-assets-cn entry, group by category
    const newData: BossCoinShopData = {};
    const newCatMap: CatMap = {};

    for (const [itemId, rows] of Object.entries(wfData)) {
        const raw = rows[0];
        if (!raw || raw.length < 35) continue;

        const catId = raw[0];
        if (catId === "(None)" || catId === "") continue;

        const item = parseWfBossCoinItem(raw);
        if (!item) continue;

        // Prefer existing item (preserves modified dates from starpoint-cn)
        const existingItem = existingData[catId]?.[itemId];

        if (!newData[catId]) newData[catId] = {};
        newData[catId][itemId] = existingItem || item;
        newCatMap[itemId] = parseInt(catId, 10);
    }

    // Count stats
    let totalItems = 0;
    const categories = Object.keys(newData).sort((a, b) => parseInt(a) - parseInt(b));
    for (const cat of categories) {
        const count = Object.keys(newData[cat]).length;
        totalItems += count;
        const existingCount = existingData[cat] ? Object.keys(existingData[cat]).length : 0;
        const newCount = count - existingCount;
        const tag = existingCount === 0 ? " [NEW]" : existingCount < count ? ` [+${newCount} new]` : "";
        console.log(`  Category ${cat}: ${count} items${tag}`);
    }

    console.log(`\nTotal categories: ${categories.length}`);
    console.log(`Total items: ${totalItems}`);
    console.log(`All category IDs: ${categories.join(", ")}`);

    // Write output
    fs.writeFileSync(OUTPUT_SHOP, JSON.stringify(newData, null, 2));
    console.log(`\nWritten: ${OUTPUT_SHOP}`);

    fs.writeFileSync(OUTPUT_CATMAP, JSON.stringify(newCatMap, null, 2));
    console.log(`Written: ${OUTPUT_CATMAP}`);
}

main();
