import { getDb } from "../../data/db"

export function isGiftCodeEnabledSync(): boolean {
    const result = getDb().prepare(`
        SELECT EXISTS (
            SELECT 1 FROM server_gift_codes WHERE status = 'active'
        ) AS enabled
    `).get() as { enabled: number }
    return result.enabled === 1
}
