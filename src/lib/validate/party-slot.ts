import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import type { Player } from "../../data/types"
import { SaveValidator } from "./types"

const PARTY_SLOT_MAX = 120

export const PartySlotValidator: SaveValidator = {
    name: "party-slot",

    validate(playerId: number, player?: Player): number {
        const currentPlayer = player ?? getPlayerSync(playerId)
        if (!currentPlayer?.id) return 0

        if (currentPlayer.partySlot >= 1 && currentPlayer.partySlot <= PARTY_SLOT_MAX) return 0

        updatePlayerSync({ id: playerId, partySlot: 1 })
        return 1
    }
}
