// 切片 2 步 2e:入房流水线阶段观测(行为不变)。
// 入房四段(issue/admit → consume/handshake → enter)在内核 joiners 里本就
// 有阶段记录;本模块把"每个真人入场走到哪一段、在哪一段被拒"聚合成计数,
// 经 server/status 的 multiplayer.entryPipeline 暴露——失败矩阵(重复票/
// 过期票/代次不符/握手期解散)的证据面。NPC 虚拟入场不计数(无网络票)。

const counters = {
    issued: 0,
    issueRejected: 0,
    consumed: 0,
    handshakeAccepted: 0,
    handshakeRejected: 0,
    enterAccepted: 0,
    enterRejected: 0,
    rollbackMembersRemoved: 0,
}

export function recordEntryStage(
    stage: keyof typeof counters,
    count = 1,
): void {
    counters[stage] += count
}

export function getEntryPipelineStatus(): Readonly<typeof counters> {
    return Object.freeze({ ...counters })
}

export function resetEntryPipelineForTest(): void {
    for (const key of Object.keys(counters) as (keyof typeof counters)[]) {
        counters[key] = 0
    }
}
