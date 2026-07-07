require("ts-node/register");

const assert = require("assert");

const {
  drawGachaWithMetadataSync,
  selectWeightedIndexByRoll,
} = require("../src/lib/gacha.ts");

assert.strictEqual(selectWeightedIndexByRoll([0, 1000], 1), 1);
assert.strictEqual(selectWeightedIndexByRoll([50, 950], 50), 0);
assert.strictEqual(selectWeightedIndexByRoll([50, 950], 51), 1);
assert.strictEqual(selectWeightedIndexByRoll([75, 925], 75), 0);
assert.strictEqual(selectWeightedIndexByRoll([75, 925], 76), 1);
assert.strictEqual(selectWeightedIndexByRoll([1000, 0], 1000), 0);
assert.strictEqual(selectWeightedIndexByRoll([0, 0], 1), null);

const forcedGuaranteeGacha = {
  type: 1,
  rankRates: {
    normal: [0, 0, 1000],
    multiGuarantee: [0, 1000],
  },
  pool: {
    "2": [{ id: 400001, rank: 4, odds: 1 }],
    "3": [{ id: 300001, rank: 3, odds: 1 }],
  },
};

const metadataDraws = drawGachaWithMetadataSync(forcedGuaranteeGacha, 10);
assert.deepStrictEqual(
  metadataDraws.map(({ id, rank, isGuarantee }) => ({ id, rank, isGuarantee })),
  [
    { id: 300001, rank: 3, isGuarantee: false },
    { id: 300001, rank: 3, isGuarantee: false },
    { id: 300001, rank: 3, isGuarantee: false },
    { id: 300001, rank: 3, isGuarantee: false },
    { id: 300001, rank: 3, isGuarantee: false },
    { id: 300001, rank: 3, isGuarantee: false },
    { id: 300001, rank: 3, isGuarantee: false },
    { id: 300001, rank: 3, isGuarantee: false },
    { id: 300001, rank: 3, isGuarantee: false },
    { id: 400001, rank: 4, isGuarantee: true },
  ],
);

const twentyDraws = drawGachaWithMetadataSync(forcedGuaranteeGacha, 20);
assert.deepStrictEqual(
  twentyDraws.map((draw) => draw.isGuarantee),
  [
    false, false, false, false, false, false, false, false, false, true,
    false, false, false, false, false, false, false, false, false, true,
  ],
);

console.log("gacha_draw_weights tests passed");
