import {
    getEquipmentDissolveSync,
    getEquipmentCraftSync,
    getEquipmentRaritySync,
} from "./equipment-content";

export interface DissolveRewards {
    craftPoints: number;
    starGrains: number;
    /** Item ID → count map for ability souls granted */
    abilitySouls: Record<number, number>;
}

/**
 * Calculate dissolve rewards for one equipment type × count stacks.
 *
 * CDN checks applied:
 * - generate_ability_soul: only grant ability souls if `true`
 * - obtain_source: only grant star grains if `0`
 *
 * Craft-point and star-grain values loaded from CDN equipment_craft.json.
 *
 * @param equipmentId  The equipment ID being dissolved.
 * @param count        How many stacks to dissolve.
 * @returns Rewards struct for a validated Content definition.
 */
export function calculateDissolveRewards(
    equipmentId: number,
    count: number
): DissolveRewards {
    const cdn = getEquipmentDissolveSync(equipmentId);
    if (cdn === null) throw new Error(`Missing equipment definition ${equipmentId}`)
    const rarity = getEquipmentRaritySync(equipmentId)
    if (rarity === null) throw new Error(`Missing equipment rarity definition ${equipmentId}`)
    const craftEntry = getEquipmentCraftSync(rarity);
    if (craftEntry === null) throw new Error(`Missing equipment craft definition for rarity ${rarity}`)
    const craftPoints = craftEntry.dissolve_craft * count;

    // Star grains: only if obtain_source == 0
    const starGrains =
        cdn.obtain_source === 0
            ? craftEntry.dissolve_star * count
            : 0;

    // All three dissolve paths follow the CDN flag; `count` is the number of
    // equipment units actually removed by the request.
    const abilitySouls: Record<number, number> = {};
    if (cdn.generate_ability_soul) {
        const soulId = cdn.ability_soul_id;
        abilitySouls[soulId] = count;
    }

    return { craftPoints, starGrains, abilitySouls };
}
