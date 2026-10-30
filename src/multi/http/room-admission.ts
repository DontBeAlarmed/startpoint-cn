import type { AdmissionIssueResult } from "../admission/registry"
import type { ParticipantIdentity } from "../coordinator/contracts"
import { lifecycleRegistry } from "../lifecycle"
import type { MultiHttpContext } from "./context"

export async function issueRoomAdmission(
    context: MultiHttpContext,
    roomNumber: string,
    viewerId: number,
    participant: ParticipantIdentity,
): Promise<AdmissionIssueResult | null> {
    const prepared = await context.snapshotProvider.prepareAdmission(viewerId)
    if (!prepared) return null

    // 内核 admit 由 AdmissionRegistry 在发票成功时记录（owner 权威），
    // 本地与远程发票走同一条流水线。
    return context.admissionIssuer.issue({
        roomNumber,
        participant,
        snapshot: prepared.snapshot,
        expiresAt: context.now() + context.admissionTtlMs,
        lifecycleGeneration: lifecycleRegistry.get(roomNumber)?.generation,
    })
}
