import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../../content/runtime/content-snapshot"
import {
    validateSpecialExchangeCampaignTable,
    validateSpecialExchangeSubTable,
    type SpecialExchangeCampaignDefinition,
    type SpecialExchangeCampaignKind,
} from "../../content/converters/special-exchange"

export type SpecialExchangeCampaignTable =
    Readonly<Record<string, SpecialExchangeCampaignDefinition>>

export type {
    SpecialExchangeCampaignDefinition,
    SpecialExchangeCampaignKind,
} from "../../content/converters/special-exchange"

const campaignTables = new WeakMap<ReadonlyContentRepository, SpecialExchangeCampaignTable>()
const characterLineups = new WeakMap<ReadonlyContentRepository, Readonly<Record<string, readonly number[]>>>()
const equipmentLineups = new WeakMap<ReadonlyContentRepository, Readonly<Record<string, readonly number[]>>>()

export function getSpecialExchangeCampaignTable(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): SpecialExchangeCampaignTable {
    const cached = campaignTables.get(repository)
    if (cached !== undefined) return cached
    const table = validateSpecialExchangeCampaignTable(
        repository.table("special_exchange_campaign.json"),
    )
    campaignTables.set(repository, table)
    return table
}

export function getSpecialExchangeCharacterLineups(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): Readonly<Record<string, readonly number[]>> {
    const cached = characterLineups.get(repository)
    if (cached !== undefined) return cached
    const table = validateSpecialExchangeSubTable(
        repository.table("special_exchange_campaign_character.json"),
        "special_exchange_campaign_character",
        getSpecialExchangeCampaignTable(repository),
    )
    characterLineups.set(repository, table)
    return table
}

export function getSpecialExchangeEquipmentLineups(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): Readonly<Record<string, readonly number[]>> {
    const cached = equipmentLineups.get(repository)
    if (cached !== undefined) return cached
    const table = validateSpecialExchangeSubTable(
        repository.table("special_exchange_campaign_equipment.json"),
        "special_exchange_campaign_equipment",
        getSpecialExchangeCampaignTable(repository),
    )
    equipmentLineups.set(repository, table)
    return table
}

export function resolveSpecialExchangeCampaign(
    campaignId: number,
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): SpecialExchangeCampaignDefinition | undefined {
    return getSpecialExchangeCampaignTable(repository)[String(campaignId)]
}

export function getSpecialExchangeLineup(
    campaign: SpecialExchangeCampaignDefinition,
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): readonly number[] {
    const lineups = campaign.type === 0
        ? getSpecialExchangeCharacterLineups(repository)
        : getSpecialExchangeEquipmentLineups(repository)
    const lineup = lineups[String(campaign.campaignId)]
    if (lineup === undefined) {
        throw new Error(
            `special exchange campaign ${campaign.campaignId} is missing its exchange lineup`,
        )
    }
    return lineup
}

/** 客户端 ExchangeCampaignType：0=角色，1=装备。 */
export function specialExchangeKindOf(
    campaign: SpecialExchangeCampaignDefinition,
): SpecialExchangeCampaignKind {
    return campaign.type
}
