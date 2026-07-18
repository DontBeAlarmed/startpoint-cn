const assert = require("node:assert/strict");
const path = require("node:path");

const serverShop = require("../assets/star_grain_shop.json");
const cnShop = require(path.resolve(
    __dirname,
    "../../wf-assets-cn/orderedmap/shop/star_grain_shop.json",
));

const REWARD_SLOT_STARTS = [25, 28, 31, 34, 37, 40];
const MATERIAL_PACK_IDS = [100017, 100018, 100019, 100020, 100021, 100022];
const COMBINATION_REWARD_IDS = [
    100038, 100039, 100040, 100041, 100042, 100043, 100044,
    100045, 100046, 100047, 100048, 100049, 100050, 100051,
];

function expectedRewardsFromCn(productId) {
    const raw = cnShop[String(productId)]?.[0];
    assert.ok(raw, `CN 主数据缺少商品 ${productId}`);

    return REWARD_SLOT_STARTS.flatMap((slotStart) => {
        const values = raw.slice(slotStart, slotStart + 3);
        if (values[0] === "(None)" && values[1] === "" && values[2] === "") {
            return [];
        }
        return [{
            type: Number(values[0]),
            id: Number(values[1]),
            count: Number(values[2]),
        }];
    });
}

for (const productId of MATERIAL_PACK_IDS) {
    const serverItem = serverShop[String(productId)];
    assert.ok(serverItem, `服务端资产缺少素材箱 ${productId}`);

    const expectedRewards = expectedRewardsFromCn(productId);
    assert.deepEqual(
        serverItem.rewards,
        expectedRewards,
        `素材箱 ${productId} 的 rewards 必须逐项匹配 CN 六槽主数据`,
    );
    assert.equal(serverItem.rewards.length, 6, `素材箱 ${productId} 必须包含 6 项奖励`);
    assert.equal(
        serverItem.rewards.some((reward) => reward.id === productId),
        false,
        `素材箱 ${productId} 不能把商品自身作为背包奖励`,
    );
}

assert.deepEqual(serverShop["100017"].rewards, [
    { type: 0, id: 10001, count: 1 },
    { type: 0, id: 1, count: 175 },
    { type: 0, id: 2, count: 140 },
    { type: 0, id: 3, count: 75 },
    { type: 0, id: 4, count: 25 },
    { type: 0, id: 99, count: 25 },
]);

for (const productId of COMBINATION_REWARD_IDS) {
    assert.deepEqual(
        serverShop[String(productId)]?.rewards,
        expectedRewardsFromCn(productId),
        `组合奖励商品 ${productId} 不能在重建时回归`,
    );
}

require("ts-node/register");
const { parseRewardSlots } = require("./rebuild_star_grain_shop.ts");

const malformedSlots = Array(43).fill("");
for (const slotStart of REWARD_SLOT_STARTS) malformedSlots[slotStart] = "(None)";
malformedSlots[25] = "0";
malformedSlots[26] = "10001";
malformedSlots[27] = "1";
malformedSlots[28] = "";
malformedSlots[29] = "1";
malformedSlots[30] = "175";
assert.throws(
    () => parseRewardSlots("100017", malformedSlots),
    /商品 100017 奖励槽位 28 无效/,
    "非空槽缺少 type 时必须报告商品 ID 与槽位",
);

malformedSlots[28] = "0";
malformedSlots[30] = "0";
assert.throws(
    () => parseRewardSlots("100017", malformedSlots),
    /商品 100017 奖励槽位 28 无效/,
    "非空槽 count 不为正数时必须报告商品 ID 与槽位",
);

for (const slotStart of REWARD_SLOT_STARTS.slice(1)) {
    malformedSlots[slotStart] = "(None)";
    malformedSlots[slotStart + 1] = "";
    malformedSlots[slotStart + 2] = "";
}
assert.deepEqual(parseRewardSlots("100017", malformedSlots), [
    { type: 0, id: 10001, count: 1 },
]);

console.log("star grain material pack asset tests passed");
