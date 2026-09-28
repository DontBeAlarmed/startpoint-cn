import { getEquipmentDissolveSync } from "../equipment-content"
import { getPlayerEquipmentListSync, updatePlayerEquipmentSync } from "../../data/domains/equipment"
import { SaveValidator } from "./types"

/**
 * Permanent validator: clamps equipment level to CDN max_level.
 * Equipment like 5020043 (终结者) has max_level=1 and cannot be awakened.
 * If level exceeds max_level (e.g. from direct DB manipulation), clamp it.
 */
export const MaxLevelValidator: SaveValidator = {
    name: "max-level",

    validate(playerId: number): number {
        let fixes = 0
        const allEquipment = getPlayerEquipmentListSync(playerId)

        for (const [equipId, equip] of Object.entries(allEquipment)) {
            const cdn = getEquipmentDissolveSync(parseInt(equipId))
            if (!cdn || cdn.max_level === undefined) continue

            const maxLevel = cdn.max_level
            if (equip.level > maxLevel) {
                updatePlayerEquipmentSync(playerId, equipId, { level: maxLevel })
                console.log(`[VALIDATE:max-level] account=${playerId} eid=${equipId} level ${equip.level}→${maxLevel} (max=${maxLevel})`)
                fixes++
            }
        }

        if (fixes > 0) {
            console.log(`[VALIDATE:max-level] player=${playerId}: ${fixes} equipment levels clamped`)
        }
        return fixes
    }
}
