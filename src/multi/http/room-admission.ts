import type { AdmissionIssueResult } from "../admission/registry"
import type { ParticipantIdentity } from "../coordinator/contracts"
import { identityOf, lifecycleRegistry } from "../lifecycle"
import type { MultiHttpContext } from "./context"

export async function issueRoomAdmission(
    context: MultiHttpContext,
    roomNumber: string,
    viewerId: number,
    participant: ParticipantIdentity,
): Promise<AdmissionIssueResult | null> {
    const prepared = await context.snapshotProvider.prepareAdmission(viewerId)
    if (!prepared) return null

    const issued = await context.admissionIssuer.issue({
        roomNumber,
        participant,
        snapshot: prepared.snapshot,
        expiresAt: context.now() + context.admissionTtlMs,
    })
    if (issued.ok) {
        // B2a 影子：入场票签发 = 入房流水线的 admitted 阶段。
        lifecycleRegistry.dispatch(roomNumber, generation => ({
            type: "admit",
            generation,
            identity: identityOf(participant),
        }))
    }
    return issued
}
