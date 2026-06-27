import type { MultiRoom, MultiMate, CompanionInfo } from "../types"
import type { IRoomMateProvider, RecruitResult } from "../types"
import type { NpcMateTemplate } from "../../lib/types"
import { NPC_TEMPLATES } from "./types"
import { buildNpcMates } from "./builder"

export class NpcMateProvider implements IRoomMateProvider {
    getMates(roomNumber: string): MultiMate[] {
        const { mate1, mate2 } = buildNpcMates()
        return [mate1, mate2].filter((m): m is MultiMate => m !== null)
    }

    async onRecruit(roomNumber: string, hostViewerId: string): Promise<RecruitResult> {
        return {
            recruitedMates: [
                { viewer_id: 900000001, com_id: 1 },
                { viewer_id: 900000002, com_id: 2 },
            ],
        }
    }

    isRoomFull(roomNumber: string): boolean {
        return true
    }

    getAvailableCompanions(hostViewerId: string): CompanionInfo[] {
        return []
    }
}
