import { getEquipmentDissolveSync, getEquipmentCraftSync } from "./equipment-content";

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
    const rarity = Math.floor(equipmentId / 1000000);  // 1-indexed, matches CDN keys
    const craftEntry = getEquipmentCraftSync(rarity);
    const cdn = getEquipmentDissolveSync(equipmentId);
    if (craftEntry === null) throw new Error(`Missing equipment craft definition for rarity ${rarity}`)
    if (cdn === null) throw new Error(`Missing equipment definition ${equipmentId}`)
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
