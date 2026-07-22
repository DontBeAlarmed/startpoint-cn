const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const dotGitPath = path.join(projectRoot, ".git");
const mainRepositoryRoot = fs.statSync(dotGitPath).isDirectory()
    ? projectRoot
    : path.resolve(
        projectRoot,
        fs.readFileSync(dotGitPath, "utf8").trim().replace(/^gitdir:\s*/, ""),
        "../../..",
    );
const serverAssetPath = path.resolve(projectRoot, "assets/star_grain_shop.json");
const generatorPath = path.resolve(__dirname, "rebuild_star_grain_shop.ts");
const tsNodePath = path.resolve(projectRoot, "node_modules/ts-node/dist/bin.js");
const cnSourcePath = path.resolve(
    mainRepositoryRoot,
    "../wf-assets-cn/orderedmap/shop/star_grain_shop.json",
);
const serverShop = require(serverAssetPath);
const cnShop = require(cnSourcePath);

const REWARD_SLOT_STARTS = [25, 28, 31, 34, 37, 40];
const MATERIAL_PACK_IDS = [100017, 100018, 100019, 100020, 100021, 100022];
const COMBINATION_REWARD_IDS = [
    100038, 100039, 100040, 100041, 100042, 100043, 100044,
    100045, 100046, 100047, 100048, 100049, 100050, 100051,
];

const cnProductIds = Object.keys(cnShop)
    .filter((productId) => productId !== "9999")
    .sort();
assert.deepEqual(
    Object.keys(serverShop).sort(),
    cnProductIds,
    "服务端资产不得保留没有 CN 来源的 orphan 商品",
);

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

require("ts-node/register/transpile-only");
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

malformedSlots[28] = "999";
malformedSlots[30] = "175";
assert.throws(
    () => parseRewardSlots("100017", malformedSlots),
    /商品 100017 奖励槽位 28 无效/,
    "reward type 超出 ShopItemRewardType 0-4 时必须报告商品 ID 与槽位",
);

for (const slotStart of REWARD_SLOT_STARTS.slice(1)) {
    malformedSlots[slotStart] = "(None)";
    malformedSlots[slotStart + 1] = "";
    malformedSlots[slotStart + 2] = "";
}
assert.deepEqual(parseRewardSlots("100017", malformedSlots), [
    { type: 0, id: 10001, count: 1 },
]);

function sha256(content) {
    return crypto.createHash("sha256").update(content).digest("hex");
}

function runGenerator(existingPath, outputPath) {
    const result = spawnSync(process.execPath, [tsNodePath, generatorPath], {
        cwd: projectRoot,
        env: {
            ...process.env,
            TS_NODE_TRANSPILE_ONLY: "1",
            STAR_GRAIN_CDN_SOURCE: cnSourcePath,
            STAR_GRAIN_EXISTING: existingPath,
            STAR_GRAIN_OUTPUT: outputPath,
        },
        encoding: "utf8",
    });
    assert.equal(
        result.status,
        0,
        `使用隔离路径重建必须成功: ${result.stderr || result.error || "unknown error"}`,
    );
}

// Asset assertions above intentionally run before the generator can rewrite stale output.
const productionBefore = fs.readFileSync(serverAssetPath);
const productionStatBefore = fs.statSync(serverAssetPath);
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "star-grain-shop-"));
const temporaryAssetPath = path.join(temporaryDirectory, "star_grain_shop.json");

try {
    fs.writeFileSync(temporaryAssetPath, productionBefore);

    runGenerator(temporaryAssetPath, temporaryAssetPath);
    const firstGeneration = fs.readFileSync(temporaryAssetPath);
    const firstHash = sha256(firstGeneration);
    assert.deepEqual(firstGeneration, productionBefore, "临时生成结果必须等于已提交生产资产");

    runGenerator(temporaryAssetPath, temporaryAssetPath);
    const secondGeneration = fs.readFileSync(temporaryAssetPath);
    const secondHash = sha256(secondGeneration);
    assert.deepEqual(secondGeneration, firstGeneration, "连续两次生成的完整资产必须逐字节一致");
    assert.equal(secondHash, firstHash, "连续两次生成的资产 SHA-256 必须一致");

    assert.deepEqual(
        fs.readFileSync(serverAssetPath),
        productionBefore,
        "隔离重建不得修改仓库生产资产字节",
    );
    const productionStatAfter = fs.statSync(serverAssetPath);
    assert.equal(
        productionStatAfter.mtimeMs,
        productionStatBefore.mtimeMs,
        "隔离重建不得修改仓库生产资产 mtime",
    );
    assert.equal(
        productionStatAfter.mode,
        productionStatBefore.mode,
        "隔离重建不得修改仓库生产资产 mode",
    );
} finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("star grain material pack asset tests passed");
