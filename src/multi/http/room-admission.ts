import type { AdmissionIssueResult } from "../admission/registry"
import type { ParticipantIdentity } from "../coordinator/contracts"
import type { MultiHttpContext } from "./context"

export async function issueRoomAdmission(
    context: MultiHttpContext,
    roomNumber: string,
    viewerId: number,
    participant: ParticipantIdentity,
): Promise<AdmissionIssueResult | null> {
    const prepared = await context.snapshotProvider.prepareAdmission(viewerId)
    if (!prepared) return null

    return context.admissionIssuer.issue({
        roomNumber,
        participant,
        snapshot: prepared.snapshot,
        expiresAt: context.now() + context.admissionTtlMs,
    })
}
