const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const zlib = require("node:zlib")

const SALT = "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy"
const ADVENT_EVENT_LOGICAL = "master/quest/event/advent_event.orderedmap"
const ADVENT_EVENT_QUEST_LOGICAL = "master/quest/event/advent_event_quest.orderedmap"

function hashedRelativePath(logicalPath) {
    const hash = crypto.createHash("sha1").update(logicalPath + SALT).digest("hex")
    return path.join(hash.slice(0, 2), hash.slice(2))
}

function tablePath(store, logicalPath) {
    return path.join(store, hashedRelativePath(logicalPath))
}

function hasAdventTables(store) {
    return fs.existsSync(tablePath(store, ADVENT_EVENT_LOGICAL))
        && fs.existsSync(tablePath(store, ADVENT_EVENT_QUEST_LOGICAL))
}

function findRuntimeUpload(root = process.cwd()) {
    const absRoot = path.resolve(root)
    const candidates = [
        path.join(absRoot, "WorldFlipper", "dummy", "download", "production", "upload"),
    ]

    for (const entry of fs.readdirSync(absRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        candidates.push(path.join(absRoot, entry.name, "WorldFlipper", "dummy", "download", "production", "upload"))
    }

    const found = candidates.find((candidate) => fs.existsSync(candidate) && hasAdventTables(candidate))
    if (!found) {
        throw new Error(`Could not find runtime upload store under ${absRoot}`)
    }
    return found
}

function parseOrderedMapIndex(raw) {
    const indexLength = raw.readUInt32LE(0)
    const index = zlib.inflateSync(raw.subarray(4, 4 + indexLength))
    const count = index.readUInt32LE(0)
    const pairs = []
    let offset = 4
    for (let i = 0; i < count; i++) {
        pairs.push({
            keyEnd: index.readUInt32LE(offset),
            rowEnd: index.readUInt32LE(offset + 4),
        })
        offset += 8
    }

    const keys = []
    const keyBlob = index.subarray(offset)
    let previousKeyEnd = 0
    for (const pair of pairs) {
        keys.push(keyBlob.subarray(previousKeyEnd, pair.keyEnd).toString("utf8"))
        previousKeyEnd = pair.keyEnd
    }

    return { keys, pairs, indexLength }
}

function readOrderedMapFromBytes(raw, { rawRows = false } = {}) {
    const { keys, pairs, indexLength } = parseOrderedMapIndex(raw)
    const rowBlob = raw.subarray(4 + indexLength)
    const rows = {}
    let previousRowEnd = 0

    for (let i = 0; i < keys.length; i++) {
        const chunk = rowBlob.subarray(previousRowEnd, pairs[i].rowEnd)
        previousRowEnd = pairs[i].rowEnd
        if (rawRows) {
            rows[keys[i]] = Buffer.from(chunk)
        } else {
            rows[keys[i]] = chunk.length === 0 ? "" : zlib.inflateSync(chunk).toString("utf8")
        }
    }

    return { keys, rows }
}

function readOrderedMapFile(filePath, options) {
    return readOrderedMapFromBytes(fs.readFileSync(filePath), options)
}

function parseCsvLine(line) {
    const out = []
    let value = ""
    let quoted = false

    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (quoted) {
            if (ch === "\"") {
                if (line[i + 1] === "\"") {
                    value += "\""
                    i += 1
                } else {
                    quoted = false
                }
            } else {
                value += ch
            }
        } else if (ch === "\"") {
            quoted = true
        } else if (ch === ",") {
            out.push(value)
            value = ""
        } else if (ch !== "\r") {
            value += ch
        }
    }
    out.push(value)
    return out
}

function isNone(value) {
    return value === undefined || value === null || value === "" || value === "(None)"
}

function optionString(value) {
    return isNone(value) ? null : value
}

function optionInt(value) {
    if (isNone(value)) return null
    const parsed = Number.parseInt(value, 10)
    return Number.isNaN(parsed) ? null : parsed
}

function requiredInt(value, label) {
    const parsed = optionInt(value)
    if (parsed === null) {
        throw new Error(`Missing integer field ${label}: ${value}`)
    }
    return parsed
}

function numberMs(value) {
    if (isNone(value)) return 0
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.round(parsed * 1000) : 0
}

function boolValue(value, fallback = null) {
    if (isNone(value)) return fallback
    if (/^true$/i.test(value)) return true
    if (/^false$/i.test(value)) return false
    return fallback
}

function intList(value) {
    if (isNone(value)) return []
    return value.split(",").map((item) => optionInt(item)).filter((item) => item !== null)
}

function questReferenceCategory(kind) {
    const categories = {
        0: 1,
        1: 4,
        2: 2,
        3: 6,
        4: 11,
        5: 10,
        6: 7,
        7: 13,
        8: 14,
        9: 18,
        10: 19,
        11: 20,
        12: 21,
        13: 22,
        14: 3,
        15: 23,
        16: 24,
        17: 25,
        18: 26,
        19: 27,
    }
    return categories[kind] ?? null
}

function questReference(kind, value1, value2, value3, multipliedId) {
    const parsedKind = optionInt(kind)
    if (parsedKind === null) return null

    const values = [optionInt(value1), optionInt(value2), optionInt(value3)]
    const parsedMultipliedId = optionInt(multipliedId)
    return {
        kind: parsedKind,
        category: questReferenceCategory(parsedKind),
        id: parsedMultipliedId ?? values[2] ?? values[0],
        values,
    }
}

function parseEvent(eventId, line) {
    const row = parseCsvLine(line)
    return {
        id: requiredInt(eventId, "event.id"),
        stringId: row[0],
        originalEventId: optionInt(row[1]),
        name: row[2],
        listBannerPath: optionString(row[4]),
        headerKind: optionInt(row[6]),
        headerBackgroundPath: optionString(row[7]),
        logoImage: optionString(row[8]),
        mainQuestGuide: optionString(row[9]) === null ? null : {
            icon: row[9],
            iconEventLock: optionString(row[10]),
        },
        flashFrameReference: optionInt(row[11]),
        autoPlayStoryQuestId: optionInt(row[12]),
        websiteEventDataId: optionInt(row[13]),
        bgm: optionString(row[14]),
        gameSystemUnlock: optionString(row[15]),
        richUi: boolValue(row[16], false),
        dropItemIdList: [row[17], row[18], row[19], row[20]].map(optionInt).filter((item) => item !== null),
        availableMissionLink: boolValue(row[21], false),
        howToPlayContentId: optionString(row[22]),
        useBalloonArrow: boolValue(row[23], false),
        startTime: optionString(row[24]),
        playableEndTime: optionString(row[25]),
        exchangeableEndTime: optionString(row[26]),
    }
}

function parseQuest(eventId, line) {
    const row = parseCsvLine(line)
    const id = requiredInt(row[0], "quest.id")
    const viewableNeedQuests = [
        questReference(row[7], row[8], row[9], row[10], row[11]),
        questReference(row[12], row[13], row[14], row[15], row[16]),
    ].filter(Boolean)
    const selectableNeedQuests = [
        questReference(row[36], row[37], row[38], row[39], row[40]),
        questReference(row[41], row[42], row[43], row[44], row[45]),
    ].filter(Boolean)
    const base = {
        id,
        eventId: requiredInt(eventId, "quest.eventId"),
        subId: id % 1000,
        subName: optionString(row[1]),
        name: row[2],
        thumbnailImage: optionString(row[3]),
        firstTimeClearRewardId: optionInt(row[4]),
        startTime: optionString(row[5]),
        endTime: optionString(row[6]),
        viewableNeedQuest: viewableNeedQuests[0] ?? null,
        viewableNeedQuests,
        viewableNeedQuestSetId: optionInt(row[18]),
        selectableNeedQuest: selectableNeedQuests[0] ?? null,
        selectableNeedQuests,
        selectableNeedQuestSetId: optionInt(row[35]),
    }

    if (row[52] === "0") {
        return {
            ...base,
            kind: "story",
            story: {
                outline: optionString(row[127]),
                moviePath: optionString(row[128]),
                movieUiScalePath: optionString(row[129]),
                scenarioPath: optionString(row[130]),
                isContinuous: boolValue(row[131], false),
            },
        }
    }

    if (row[52] !== "1") {
        throw new Error(`Unknown advent quest kind ${row[52]} for ${id}`)
    }

    return {
        ...base,
        kind: "battle",
        battle: {
            availablePlayKind: optionInt(row[53]),
            usesRichBattleUi: boolValue(row[54], false),
            startCutinImagePath: optionString(row[55]),
            playWin: optionInt(row[56]),
            startableUseItemMode: optionInt(row[61]),
            startableItemIds: intList(row[62]),
            startableItemCounts: intList(row[63]),
            partyRarityIds: intList(row[64]),
            partyCharacterIds: intList(row[65]),
            partyWithoutUnisonCharacterIds: intList(row[66]),
            partyUnisonDeny: boolValue(row[67], false),
            partyLimitMemberMin: optionInt(row[68]),
            partyLimitMemberMax: optionInt(row[69]),
            partyRaceIds: intList(row[70]),
            partySpecialityIds: intList(row[71]),
            partyGender: optionInt(row[72]),
            partyCharacterTagIds: intList(row[73]),
            partyElement: optionInt(row[74]),
            staminaCost: optionInt(row[75]),
            scoreRewardGroupId: optionInt(row[76]),
            rankSsRewardId: optionInt(row[77]),
            recommendedElement: optionInt(row[78]),
            hideRecommendedElement: boolValue(row[79], false),
            rankTimesMs: {
                b: numberMs(row[90]),
                a: numberMs(row[91]),
                s: numberMs(row[92]),
                ss: numberMs(row[93]),
            },
            rankItemCounts: {
                c: optionInt(row[94]) ?? 0,
                b: optionInt(row[95]) ?? 0,
                a: optionInt(row[96]) ?? 0,
                s: optionInt(row[97]) ?? 0,
                ss: optionInt(row[98]) ?? 0,
            },
            rewards: {
                rankPoint: optionInt(row[99]) ?? 0,
                characterExp: optionInt(row[100]) ?? 0,
                mana: optionInt(row[101]) ?? 0,
                poolExp: optionInt(row[102]) ?? 0,
            },
            enemyLevel: optionInt(row[112]),
            questRank: optionInt(row[113]),
            initialFeverGaugeLimit: optionInt(row[114]),
            fieldDataId: optionString(row[115]),
            bgmPrefix: optionString(row[116]),
            timeLimit: optionInt(row[117]),
            assistCharacterId: optionInt(row[118]),
            assistCharacter2Id: optionInt(row[121]),
            fixedParty: optionInt(row[124]),
            maxContinueCount: optionInt(row[125]),
            maxManaReward: optionInt(row[126]),
        },
    }
}

function readAdventMaster({ root = process.cwd(), store } = {}) {
    const uploadStore = store ? path.resolve(store) : findRuntimeUpload(root)
    const eventMap = readOrderedMapFile(tablePath(uploadStore, ADVENT_EVENT_LOGICAL))
    const questOuterMap = readOrderedMapFile(tablePath(uploadStore, ADVENT_EVENT_QUEST_LOGICAL), { rawRows: true })
    const events = {}
    const quests = {}
    const questsByEvent = {}

    for (const eventId of [...eventMap.keys].sort((a, b) => Number(a) - Number(b))) {
        events[eventId] = parseEvent(eventId, eventMap.rows[eventId])
    }

    for (const eventId of [...questOuterMap.keys].sort((a, b) => Number(a) - Number(b))) {
        const innerMap = readOrderedMapFromBytes(questOuterMap.rows[eventId])
        questsByEvent[eventId] = []
        for (const subId of [...innerMap.keys].sort((a, b) => Number(a) - Number(b))) {
            const quest = parseQuest(eventId, innerMap.rows[subId])
            quests[String(quest.id)] = quest
            questsByEvent[eventId].push(quest.id)
        }
    }

    return { store: uploadStore, events, quests, questsByEvent }
}

function writeAdventExport(master, outDir) {
    const target = path.resolve(outDir)
    fs.mkdirSync(target, { recursive: true })
    const eventsPath = path.join(target, "advent_event.json")
    const questsPath = path.join(target, "advent_event_quest_full.json")
    fs.writeFileSync(eventsPath, `${JSON.stringify(master.events, null, 2)}\n`)
    fs.writeFileSync(questsPath, `${JSON.stringify(master.quests, null, 2)}\n`)
    return { eventsPath, questsPath }
}

function argValue(args, name) {
    const index = args.indexOf(name)
    return index === -1 ? null : args[index + 1]
}

if (require.main === module) {
    const args = process.argv.slice(2)
    const root = path.resolve(argValue(args, "--root") || path.join(__dirname, ".."))
    const outDir = path.resolve(argValue(args, "--out") || path.join(root, "export", "advent"))
    const master = readAdventMaster({ root })
    const written = writeAdventExport(master, outDir)
    const questKinds = Object.values(master.quests).reduce((acc, quest) => {
        acc[quest.kind] = (acc[quest.kind] || 0) + 1
        return acc
    }, {})

    console.log(JSON.stringify({
        store: master.store,
        events: Object.keys(master.events).length,
        quests: Object.keys(master.quests).length,
        questKinds,
        eventsPath: written.eventsPath,
        questsPath: written.questsPath,
    }, null, 2))
}

module.exports = {
    ADVENT_EVENT_LOGICAL,
    ADVENT_EVENT_QUEST_LOGICAL,
    findRuntimeUpload,
    hashedRelativePath,
    readAdventMaster,
    writeAdventExport,
}
