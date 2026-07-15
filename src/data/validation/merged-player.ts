import type { MergedPlayerData } from "../types";


type UnknownRecord = Record<string, unknown>;

const REQUIRED_RECORDS = [
    "player",
    "clearedRegularMissionList",
    "characterList",
    "characterManaNodeList",
    "partyGroupList",
    "itemList",
    "equipmentList",
    "questProgress",
    "allActiveMissionList",
    "boxGachaList",
    "purchasedTimesList",
    "userOption",
] as const;

const REQUIRED_ARRAYS = [
    "dailyChallengePointList",
    "triggeredTutorial",
    "gachaInfoList",
    "gachaCampaignList",
    "drawnQuestList",
    "periodicRewardPointList",
    "startDashExchangeCampaignList",
    "multiSpecialExchangeCampaignList",
] as const;


function invalid(path: string, message: string): never {
    throw new Error(`${path}: ${message}`);
}


function isRecord(value: unknown): value is UnknownRecord {
    if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}


function requireRecord(value: unknown, path: string): UnknownRecord {
    if (!isRecord(value)) invalid(path, "must be a record");
    return value;
}


function requireArray(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) invalid(path, "must be an array");
    return value;
}


function requireSafeId(value: unknown, path: string, minimum = 0): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
        invalid(path, `must be a safe integer >= ${minimum}`);
    }
    return value;
}


function assertFiniteTree(value: unknown, path: string): void {
    if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") {
        return;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) invalid(path, "must contain only finite numbers");
        return;
    }
    if (value instanceof Date) {
        if (!Number.isFinite(value.getTime())) invalid(path, "contains an invalid Date");
        return;
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            if (!(index in value)) invalid(`${path}[${index}]`, "array holes are not allowed");
            assertFiniteTree(value[index], `${path}[${index}]`);
        }
        return;
    }
    if (!isRecord(value)) invalid(path, "contains an unsupported runtime value");
    for (const [key, child] of Object.entries(value)) {
        assertFiniteTree(child, `${path}.${key}`);
    }
}


function numericRecord(value: unknown, path: string): UnknownRecord {
    const record = requireRecord(value, path);
    const numericIds = new Set<number>();
    for (const key of Object.keys(record)) {
        if (!/^(0|[1-9][0-9]*)$/.test(key)) invalid(`${path}.${key}`, "must use a canonical numeric key");
        const id = Number(key);
        if (!Number.isSafeInteger(id)) invalid(`${path}.${key}`, "numeric key is out of range");
        if (numericIds.has(id)) invalid(path, `contains duplicate numeric id ${id}`);
        numericIds.add(id);
    }
    return record;
}


function uniquePrimitiveIds(values: unknown[], path: string): void {
    const seen = new Set<number>();
    values.forEach((value, index) => {
        const id = requireSafeId(value, `${path}[${index}]`);
        if (seen.has(id)) invalid(path, `contains duplicate numeric id ${id}`);
        seen.add(id);
    });
}


function uniqueObjects(values: unknown[], path: string, fields: readonly string[]): UnknownRecord[] {
    const seen = new Set<string>();
    return values.map((value, index) => {
        const record = requireRecord(value, `${path}[${index}]`);
        const parts = fields.map(field => requireSafeId(record[field], `${path}[${index}].${field}`));
        const identity = parts.join(":");
        if (seen.has(identity)) invalid(path, `contains duplicate numeric id ${identity}`);
        seen.add(identity);
        return record;
    });
}


function assertDateLike(value: unknown, path: string): void {
    if (value instanceof Date) {
        if (!Number.isFinite(value.getTime())) invalid(path, "must be a valid date");
        return;
    }
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
        invalid(path, "must be a valid ISO date string or Date");
    }
}


function assertOwnedId(value: unknown, owned: Set<number>, path: string): void {
    if (value === null || value === undefined || value === 0) return;
    const id = requireSafeId(value, path, 1);
    if (!owned.has(id)) invalid(path, `references missing id ${id}`);
}


function assertOwnedArray(
    value: unknown,
    owned: Set<number>,
    path: string,
    expectedLength = 3,
): void {
    const ids = requireArray(value, path);
    if (ids.length !== expectedLength) invalid(path, `must contain exactly ${expectedLength} entries`);
    ids.forEach((id, index) => assertOwnedId(id, owned, `${path}[${index}]`));
}


function keyIds(record: UnknownRecord): Set<number> {
    return new Set(Object.keys(record).map(Number));
}


export function assertMergedPlayerData(
    value: unknown,
    expectedPlayerId: number,
    expectedAccountId: number,
): asserts value is MergedPlayerData {
    requireSafeId(expectedPlayerId, "expectedPlayerId", 1);
    requireSafeId(expectedAccountId, "expectedAccountId", 1);
    const root = requireRecord(value, "data");
    assertFiniteTree(root, "data");

    for (const field of REQUIRED_RECORDS) requireRecord(root[field], `data.${field}`);
    for (const field of REQUIRED_ARRAYS) requireArray(root[field], `data.${field}`);

    const player = requireRecord(root.player, "data.player");
    const playerId = requireSafeId(player.id, "data.player.id", 1);
    if (playerId !== expectedPlayerId) invalid("data.player.id", `expected ${expectedPlayerId}`);
    if (player.accountId !== undefined) {
        const accountId = requireSafeId(player.accountId, "data.player.accountId", 1);
        if (accountId !== expectedAccountId) invalid("data.player.accountId", `expected ${expectedAccountId}`);
    }
    for (const field of ["staminaHealTime", "lastLoginTime", "expPooledTime"] as const) {
        assertDateLike(player[field], `data.player.${field}`);
    }

    const characters = numericRecord(root.characterList, "data.characterList");
    const characterIds = keyIds(characters);
    const equipment = numericRecord(root.equipmentList, "data.equipmentList");
    const equipmentIds = keyIds(equipment);
    numericRecord(root.itemList, "data.itemList");
    numericRecord(root.clearedRegularMissionList, "data.clearedRegularMissionList");
    numericRecord(root.purchasedTimesList, "data.purchasedTimesList");
    if (Object.keys(root.purchasedTimesList as UnknownRecord).length !== 0) {
        invalid("data.purchasedTimesList", "non-empty values are not supported by the database schema");
    }

    for (const [characterId, rawCharacter] of Object.entries(characters)) {
        const character = requireRecord(rawCharacter, `data.characterList.${characterId}`);
        assertDateLike(character.joinTime, `data.characterList.${characterId}.joinTime`);
        assertDateLike(character.updateTime, `data.characterList.${characterId}.updateTime`);
        const bonds = requireArray(character.bondTokenList, `data.characterList.${characterId}.bondTokenList`);
        uniqueObjects(bonds, `data.characterList.${characterId}.bondTokenList`, ["manaBoardIndex"]);
    }

    const manaNodes = numericRecord(root.characterManaNodeList, "data.characterManaNodeList");
    for (const [characterId, rawNodes] of Object.entries(manaNodes)) {
        if (!characterIds.has(Number(characterId))) {
            invalid(`data.characterManaNodeList.${characterId}`, "references a missing character");
        }
        const nodes = requireArray(rawNodes, `data.characterManaNodeList.${characterId}`);
        uniquePrimitiveIds(nodes, `data.characterManaNodeList.${characterId}`);
    }

    if (root.characterManaNodeAwakeLevels !== undefined) {
        const awakeCharacters = numericRecord(
            root.characterManaNodeAwakeLevels,
            "data.characterManaNodeAwakeLevels",
        );
        for (const [characterId, rawLevels] of Object.entries(awakeCharacters)) {
            if (!characterIds.has(Number(characterId))) {
                invalid(`data.characterManaNodeAwakeLevels.${characterId}`, "references a missing character");
            }
            const levels = numericRecord(rawLevels, `data.characterManaNodeAwakeLevels.${characterId}`);
            const unlocked = new Set((manaNodes[characterId] as unknown[] | undefined)?.map(Number) ?? []);
            for (const [nodeId, level] of Object.entries(levels)) {
                if (!unlocked.has(Number(nodeId))) {
                    invalid(`data.characterManaNodeAwakeLevels.${characterId}.${nodeId}`, "references a missing mana node");
                }
                requireSafeId(level, `data.characterManaNodeAwakeLevels.${characterId}.${nodeId}`);
            }
        }
    }

    assertOwnedId(player.leaderCharacterId, characterIds, "data.player.leaderCharacterId");

    const partyGroups = numericRecord(root.partyGroupList, "data.partyGroupList");
    for (const [groupId, rawGroup] of Object.entries(partyGroups)) {
        const group = requireRecord(rawGroup, `data.partyGroupList.${groupId}`);
        const parties = numericRecord(group.list, `data.partyGroupList.${groupId}.list`);
        for (const [slot, rawParty] of Object.entries(parties)) {
            const party = requireRecord(rawParty, `data.partyGroupList.${groupId}.list.${slot}`);
            assertOwnedArray(party.characterIds, characterIds, `data.partyGroupList.${groupId}.list.${slot}.characterIds`);
            assertOwnedArray(party.unisonCharacterIds, characterIds, `data.partyGroupList.${groupId}.list.${slot}.unisonCharacterIds`);
            assertOwnedArray(party.equipmentIds, equipmentIds, `data.partyGroupList.${groupId}.list.${slot}.equipmentIds`);
        }
    }
    const partySlot = requireSafeId(player.partySlot, "data.player.partySlot", 1);
    const selectedGroup = String(Math.floor((partySlot - 1) / 10) + 1);
    const selectedSlot = String(((partySlot - 1) % 10) + 1);
    const selectedGroupRecord = partyGroups[selectedGroup];
    if (!isRecord(selectedGroupRecord) || !isRecord(selectedGroupRecord.list)
        || selectedGroupRecord.list[selectedSlot] === undefined) {
        invalid("data.player.partySlot", `references missing party ${selectedGroup}/${selectedSlot}`);
    }

    const daily = requireArray(root.dailyChallengePointList, "data.dailyChallengePointList");
    for (const [index, entry] of uniqueObjects(daily, "data.dailyChallengePointList", ["id"]).entries()) {
        const campaigns = requireArray(entry.campaignList, `data.dailyChallengePointList[${index}].campaignList`);
        uniqueObjects(campaigns, `data.dailyChallengePointList[${index}].campaignList`, ["campaignId"]);
    }
    uniquePrimitiveIds(requireArray(root.triggeredTutorial, "data.triggeredTutorial"), "data.triggeredTutorial");
    uniqueObjects(requireArray(root.gachaInfoList, "data.gachaInfoList"), "data.gachaInfoList", ["gachaId"]);
    uniqueObjects(requireArray(root.gachaCampaignList, "data.gachaCampaignList"), "data.gachaCampaignList", ["gachaId", "campaignId"]);
    uniqueObjects(requireArray(root.drawnQuestList, "data.drawnQuestList"), "data.drawnQuestList", ["categoryId", "questId"]);
    uniqueObjects(requireArray(root.periodicRewardPointList, "data.periodicRewardPointList"), "data.periodicRewardPointList", ["id"]);
    uniqueObjects(
        requireArray(root.startDashExchangeCampaignList, "data.startDashExchangeCampaignList"),
        "data.startDashExchangeCampaignList",
        ["campaignId", "gachaId", "termIndex"],
    ).forEach((campaign, index) => {
        assertDateLike(campaign.periodStartTime, `data.startDashExchangeCampaignList[${index}].periodStartTime`);
        assertDateLike(campaign.periodEndTime, `data.startDashExchangeCampaignList[${index}].periodEndTime`);
    });
    uniqueObjects(
        requireArray(root.multiSpecialExchangeCampaignList, "data.multiSpecialExchangeCampaignList"),
        "data.multiSpecialExchangeCampaignList",
        ["campaignId"],
    );

    const questProgress = numericRecord(root.questProgress, "data.questProgress");
    for (const [section, rawQuests] of Object.entries(questProgress)) {
        const quests = uniqueObjects(
            requireArray(rawQuests, `data.questProgress.${section}`),
            `data.questProgress.${section}`,
            ["questId"],
        );
        quests.forEach((quest, index) => assertOwnedId(
            quest.leaderCharacterId,
            characterIds,
            `data.questProgress.${section}[${index}].leaderCharacterId`,
        ));
    }

    const activeMissions = numericRecord(root.allActiveMissionList, "data.allActiveMissionList");
    for (const [missionId, rawMission] of Object.entries(activeMissions)) {
        const mission = requireRecord(rawMission, `data.allActiveMissionList.${missionId}`);
        if (!Array.isArray(mission.stages)) numericRecord(mission.stages, `data.allActiveMissionList.${missionId}.stages`);
    }
    const boxGacha = numericRecord(root.boxGachaList, "data.boxGachaList");
    for (const [gachaId, boxes] of Object.entries(boxGacha)) {
        uniqueObjects(requireArray(boxes, `data.boxGachaList.${gachaId}`), `data.boxGachaList.${gachaId}`, ["boxId"]);
    }
    for (const [key, option] of Object.entries(requireRecord(root.userOption, "data.userOption"))) {
        if (typeof option !== "boolean") invalid(`data.userOption.${key}`, "must be boolean");
    }

    if (root.rushEventList !== undefined) {
        const events = uniqueObjects(requireArray(root.rushEventList, "data.rushEventList"), "data.rushEventList", ["eventId"]);
        events.forEach((event, index) => assertOwnedArray(
            event.endlessBattleMaxRoundCharacterIds,
            characterIds,
            `data.rushEventList[${index}].endlessBattleMaxRoundCharacterIds`,
        ));
    }
    if (root.rushEventClearedFolderList !== undefined) {
        const cleared = numericRecord(root.rushEventClearedFolderList, "data.rushEventClearedFolderList");
        for (const [eventId, folders] of Object.entries(cleared)) {
            const list = requireArray(folders, `data.rushEventClearedFolderList.${eventId}`);
            uniquePrimitiveIds(list, `data.rushEventClearedFolderList.${eventId}`);
        }
    }
    if (root.rushEventPlayedPartyList !== undefined) {
        const played = numericRecord(root.rushEventPlayedPartyList, "data.rushEventPlayedPartyList");
        for (const [eventId, parties] of Object.entries(played)) {
            const listPath = `data.rushEventPlayedPartyList.${eventId}`;
            const list = uniqueObjects(requireArray(parties, listPath), listPath, ["battleType", "round"]);
            list.forEach((party, index) => {
                assertOwnedArray(party.characterIds, characterIds, `${listPath}[${index}].characterIds`);
                assertOwnedArray(party.unisonCharacterIds, characterIds, `${listPath}[${index}].unisonCharacterIds`);
                assertOwnedArray(party.equipmentIds, equipmentIds, `${listPath}[${index}].equipmentIds`);
            });
        }
    }
}


function countRecord(value: Record<string, unknown> | undefined): number {
    return value === undefined ? 0 : Object.keys(value).length;
}


function countNestedArrays(value: Record<string, unknown[]> | undefined): number {
    return value === undefined
        ? 0
        : Object.values(value).reduce((sum, entries) => sum + entries.length, 0);
}


export function mergedPlayerCollectionCounts(data: MergedPlayerData): Record<string, number> {
    return {
        dailyChallenges: data.dailyChallengePointList.length,
        dailyCampaigns: data.dailyChallengePointList.reduce((sum, entry) => sum + entry.campaignList.length, 0),
        tutorials: data.triggeredTutorial.length,
        clearedMissions: countRecord(data.clearedRegularMissionList),
        characters: countRecord(data.characterList),
        characterBonds: Object.values(data.characterList).reduce((sum, character) => sum + character.bondTokenList.length, 0),
        manaNodeCharacters: countRecord(data.characterManaNodeList),
        manaNodes: countNestedArrays(data.characterManaNodeList),
        awakeCharacters: countRecord(data.characterManaNodeAwakeLevels),
        awakeNodes: data.characterManaNodeAwakeLevels === undefined
            ? 0
            : Object.values(data.characterManaNodeAwakeLevels).reduce((sum, levels) => sum + Object.keys(levels).length, 0),
        partyGroups: countRecord(data.partyGroupList),
        parties: Object.values(data.partyGroupList).reduce((sum, group) => sum + Object.keys(group.list).length, 0),
        items: countRecord(data.itemList),
        equipment: countRecord(data.equipmentList),
        questSections: countRecord(data.questProgress),
        quests: countNestedArrays(data.questProgress),
        gachaInfo: data.gachaInfoList.length,
        gachaCampaigns: data.gachaCampaignList.length,
        drawnQuests: data.drawnQuestList.length,
        periodicRewards: data.periodicRewardPointList.length,
        activeMissions: countRecord(data.allActiveMissionList),
        boxGachaGroups: countRecord(data.boxGachaList),
        boxGachas: countNestedArrays(data.boxGachaList),
        startDashCampaigns: data.startDashExchangeCampaignList.length,
        multiSpecialCampaigns: data.multiSpecialExchangeCampaignList.length,
        userOptions: countRecord(data.userOption),
        rushEvents: data.rushEventList?.length ?? 0,
        rushClearedEvents: countRecord(data.rushEventClearedFolderList),
        rushClearedFolders: countNestedArrays(data.rushEventClearedFolderList),
        rushPlayedEvents: countRecord(data.rushEventPlayedPartyList),
        rushPlayedParties: countNestedArrays(data.rushEventPlayedPartyList),
    };
}
