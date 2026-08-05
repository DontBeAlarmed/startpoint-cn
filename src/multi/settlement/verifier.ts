import { participantKey, type BattleSessionId, type NodeSessionId } from "../coordinator/contracts"
import type { MultiCoordinator } from "../coordinator/interface"

export interface MultiSettlementIdentity {
    readonly nodeSessionId: NodeSessionId
    readonly viewerId: number
    readonly roomNumber: string
    readonly battleSessionId: string
}

export type MultiSettlementVerification =
    | { readonly ok: true; readonly isHost: boolean }
    | { readonly ok: false }

export class MultiSettlementVerifier {
    constructor(
        private readonly coordinator: Pick<MultiCoordinator, "getBattleStatus">,
    ) {}

    async verify(input: MultiSettlementIdentity): Promise<MultiSettlementVerification> {
        if (input.battleSessionId.trim().length === 0) return { ok: false }
        const participant = {
            nodeSessionId: input.nodeSessionId,
            viewerId: input.viewerId,
        }
        try {
            const result = await this.coordinator.getBattleStatus({
                participant,
                roomNumber: input.roomNumber,
                battleSessionId: input.battleSessionId as BattleSessionId,
            })
            if (!result.ok
                || !result.value.finalized
                || result.value.roomNumber !== input.roomNumber
                || result.value.battleSessionId !== input.battleSessionId) {
                return { ok: false }
            }
            const identityKey = participantKey(input.nodeSessionId, input.viewerId)
            if (!result.value.participants.some(candidate => participantKey(
                candidate.nodeSessionId,
                candidate.viewerId,
            ) === identityKey)) {
                return { ok: false }
            }
            return {
                ok: true,
                isHost: participantKey(
                    result.value.host.nodeSessionId,
                    result.value.host.viewerId,
                ) === identityKey,
            }
        } catch {
            return { ok: false }
        }
    }
}
