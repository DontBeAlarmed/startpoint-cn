import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../content/runtime/content-snapshot"
import {
    validateGrowthFundTable,
    type GrowthFundBonusDefinition,
} from "../content/converters/growth-fund"

export type GrowthFundTable = Readonly<Record<string, GrowthFundBonusDefinition>>

const growthFundTablesByRepository = new WeakMap<ReadonlyContentRepository, GrowthFundTable>()

export function getGrowthFundTable(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): GrowthFundTable {
    const cached = growthFundTablesByRepository.get(repository)
    if (cached !== undefined) return cached
    const table = validateGrowthFundTable(
        repository.table<GrowthFundTable>("growth_fund.json"),
    )
    growthFundTablesByRepository.set(repository, table)
    return table
}

// 客户端 GrowthFundItemLogic.as:32-33 的权威分段（修行之道三段购买身份对应
// 三段 rank 区间；本仓购买身份恒真后，分段仅影响语义保真，不影响可达性）。
export const LAITE_MAX_RANK = 80
export const LAITE_MAX_TREASURY1 = 180
