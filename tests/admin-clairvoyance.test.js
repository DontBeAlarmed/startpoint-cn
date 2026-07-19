require("ts-node/register/transpile-only")

const assert = require("assert")

const {
    buildShortUpCharacterGachaTimeline,
} = require("../src/lib/admin-clairvoyance")

const timeline = buildShortUpCharacterGachaTimeline(new Date("2021-10-18T14:00:00.000Z"))

assert.strictEqual(timeline.scope, "short-up-character-gacha")
assert(timeline.timeline.length > 300, "应解析固定 CDN 基线内的短期 UP 角色池")
assert(timeline.current.length >= 2, "2021-10-18 22:00 中国时间应能命中同时生效的短期 UP 角色池")
assert(timeline.current.some((gacha) => gacha.id === 96), "应包含复刻角色特选扭蛋 #96")
assert(timeline.current.some((gacha) => gacha.id === 900002), "应包含当晚临时新角色特选扭蛋 #900002")
assert(timeline.timeline.every((gacha) => gacha.type === "character"), "时间线不应包含装备池")
assert(timeline.timeline.every((gacha) => gacha.pageKind === 0), "第一阶段不应包含福袋、票池、星之英雄等特殊 pageKind")
assert(timeline.timeline.every((gacha) => gacha.rateUpCharacters.length > 0), "第一阶段只展示含 UP 角色的卡池")
assert(timeline.timeline.every((gacha) => gacha.durationDays > 0 && gacha.durationDays <= 60), "第一阶段只展示短期池")

const beastFighter = timeline.searchIndex.find((row) => row.characterId === 121069)
assert(beastFighter, "搜索索引应包含 UP 角色 #121069")
assert.strictEqual(beastFighter.name, "谢胧")
assert(beastFighter.gachas.some((gacha) => gacha.id === 900002), "角色搜索应能反查到对应卡池")

console.log("admin-clairvoyance tests passed")
