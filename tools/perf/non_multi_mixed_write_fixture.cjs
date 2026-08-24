"use strict"

const { GACHA_ID } = require("./non_multi_mixed_gacha.cjs")
const { MAIL_ITEM_ID } = require("./non_multi_mixed_mail.cjs")
const {
    SHOP_ITEM_ID,
    SHOP_REWARD_EQUIPMENT_ID,
    SHOP_TYPE,
} = require("./non_multi_mixed_shop.cjs")

function prepareShopIdentity(db, identity) {
    db.transaction(() => {
        db.prepare("UPDATE players SET bond_token = 500 WHERE id = ?").run(identity.playerId)
        db.prepare("DELETE FROM players_shop_purchases WHERE player_id = ? AND shop_item_id = ?")
            .run(identity.playerId, SHOP_ITEM_ID)
        db.prepare(`
            DELETE FROM players_shop_purchase_counters
            WHERE player_id = ? AND shop_item_id = ?
        `).run(identity.playerId, SHOP_ITEM_ID)
        db.prepare("DELETE FROM players_equipment WHERE player_id = ? AND id = ?")
            .run(identity.playerId, SHOP_REWARD_EQUIPMENT_ID)
    })()
}

function inspectShopIdentity(db, identity) {
    return {
        bondToken: db.prepare("SELECT bond_token FROM players WHERE id = ?")
            .get(identity.playerId).bond_token,
        purchaseCount: db.prepare(`
            SELECT COALESCE(SUM(count), 0) AS count
            FROM players_shop_purchase_counters
            WHERE player_id = ? AND shop_type = ? AND shop_item_id = ?
              AND period_type = 'total' AND period_key = ''
        `).get(identity.playerId, SHOP_TYPE, SHOP_ITEM_ID).count,
        rewardEquipmentCount: db.prepare(`
            SELECT COUNT(*) AS count FROM players_equipment
            WHERE player_id = ? AND id = ?
        `).get(identity.playerId, SHOP_REWARD_EQUIPMENT_ID).count,
    }
}

function prepareGachaIdentity(db, identity) {
    db.transaction(() => {
        db.prepare("UPDATE players SET free_vmoney = 1000, vmoney = 0 WHERE id = ?")
            .run(identity.playerId)
        db.prepare("DELETE FROM players_gacha_info WHERE player_id = ? AND gacha_id = ?")
            .run(identity.playerId, GACHA_ID)
        db.prepare("DELETE FROM players_gacha_campaigns WHERE player_id = ? AND gacha_id = ?")
            .run(identity.playerId, GACHA_ID)
        db.prepare("DELETE FROM players_receive_history WHERE player_id = ?").run(identity.playerId)
        db.prepare("DELETE FROM players_characters WHERE player_id = ?").run(identity.playerId)
        db.prepare(`
            UPDATE players_parties SET
                character_id_1 = NULL, character_id_2 = NULL, character_id_3 = NULL,
                unison_character_1 = NULL, unison_character_2 = NULL, unison_character_3 = NULL,
                current_battle_power = 0, before_battle_power = 0
            WHERE player_id = ?
        `).run(identity.playerId)
        db.prepare("DELETE FROM players_active_mission_counters WHERE player_id = ?")
            .run(identity.playerId)
        db.prepare("DELETE FROM players_login_bonus_progress WHERE player_id = ?")
            .run(identity.playerId)
    })()
}

function inspectGachaIdentity(db, identity) {
    const gacha = db.prepare(`
        SELECT gacha_exchange_point FROM players_gacha_info
        WHERE player_id = ? AND gacha_id = ?
    `).get(identity.playerId, GACHA_ID)
    return {
        freeVmoney: db.prepare("SELECT free_vmoney FROM players WHERE id = ?")
            .get(identity.playerId).free_vmoney,
        exchangePoint: gacha?.gacha_exchange_point ?? 0,
        receiveHistoryCount: db.prepare(`
            SELECT COUNT(*) AS count FROM players_receive_history WHERE player_id = ?
        `).get(identity.playerId).count,
        characterCount: db.prepare(`
            SELECT COUNT(*) AS count FROM players_characters WHERE player_id = ?
        `).get(identity.playerId).count,
        partyCharacterReferenceCount: db.prepare(`
            SELECT COALESCE(SUM(
                (character_id_1 IS NOT NULL) + (character_id_2 IS NOT NULL) +
                (character_id_3 IS NOT NULL) + (unison_character_1 IS NOT NULL) +
                (unison_character_2 IS NOT NULL) + (unison_character_3 IS NOT NULL)
            ), 0) AS count
            FROM players_parties WHERE player_id = ?
        `).get(identity.playerId).count,
        activeMissionGachaCount: db.prepare(`
            SELECT COALESCE((
                SELECT total_gacha_character_count FROM players_active_mission_counters
                WHERE player_id = ?
            ), 0) AS count
        `).get(identity.playerId).count,
    }
}

function prepareMailIdentity(db, identity, insertMail) {
    return db.transaction(() => {
        db.prepare("DELETE FROM players_mails WHERE player_id = ?").run(identity.playerId)
        db.prepare("DELETE FROM players_receive_history WHERE player_id = ?").run(identity.playerId)
        db.prepare("DELETE FROM players_items WHERE player_id = ? AND id = ?")
            .run(identity.playerId, MAIL_ITEM_ID)
        return {
            mailId: insertMail(identity.playerId, {
                reason_id: 0,
                subject: "non-multi mixed fixture",
                description: null,
                type: 1,
                type_id: MAIL_ITEM_ID,
                number: 2,
                receive_time: "0000-00-00 00:00:00",
                create_time: "2024-08-14 12:00:00",
                reward_period_limited: 0,
                reward_limit_time: null,
            }),
        }
    })()
}

function inspectMailIdentity(db, identity) {
    return {
        itemCount: db.prepare(`
            SELECT COALESCE((SELECT amount FROM players_items WHERE player_id = ? AND id = ?), 0) AS count
        `).get(identity.playerId, MAIL_ITEM_ID).count,
        unreceivedMailCount: db.prepare(`
            SELECT COUNT(*) AS count FROM players_mails
            WHERE player_id = ? AND receive_time = '0000-00-00 00:00:00'
        `).get(identity.playerId).count,
        receiveHistoryCount: db.prepare(`
            SELECT COUNT(*) AS count FROM players_receive_history WHERE player_id = ?
        `).get(identity.playerId).count,
    }
}

function createNonMultiMixedWriteContext(db, { insertMail } = {}) {
    if (typeof insertMail !== "function") throw new TypeError("insertMail must be a function")
    return {
        prepareShopIdentity: identity => prepareShopIdentity(db, identity),
        inspectShopIdentity: identity => inspectShopIdentity(db, identity),
        prepareGachaIdentity: identity => prepareGachaIdentity(db, identity),
        inspectGachaIdentity: identity => inspectGachaIdentity(db, identity),
        prepareMailIdentity: identity => prepareMailIdentity(db, identity, insertMail),
        inspectMailIdentity: identity => inspectMailIdentity(db, identity),
    }
}

module.exports = { createNonMultiMixedWriteContext }
