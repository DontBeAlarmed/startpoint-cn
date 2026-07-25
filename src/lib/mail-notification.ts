import { getPlayerMailCountSync } from "../data/domains/mail"

/** Returns the current unreceived-mail flag used by game API responses. */
export function getMailArrivedSync(playerId: number): boolean {
    return getPlayerMailCountSync(playerId, true) > 0
}
