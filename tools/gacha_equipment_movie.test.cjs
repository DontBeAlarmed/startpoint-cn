require("ts-node/register");

const assert = require("assert");

const {
  computeEquipmentGachaMovieEffects,
  computeEquipmentGachaMovieEffectsForGacha,
  getEquipmentGachaMovieProbabilitySync,
} = require("../src/lib/gacha-equipment-movie.ts");

const normalProbability = {
  stringId: "normal",
  probabilityEruption: 0.22,
  probabilityTreasureUp3To5: 0.2,
  probabilityTreasureUp4To5: 0.35,
  probabilityTreasureUp3To4: 0.25,
  guaranteeProbabilityTreasureUp3To5: 0,
  guaranteeProbabilityTreasureUp4To5: 0.35,
  guaranteeProbabilityTreasureUp3To4: 0,
};

assert.deepStrictEqual(getEquipmentGachaMovieProbabilitySync("1"), normalProbability);
assert.strictEqual(getEquipmentGachaMovieProbabilitySync("missing"), null);

assert.deepStrictEqual(
  computeEquipmentGachaMovieEffectsForGacha(
    { equipmentMovieProbabilityId: "1" },
    [{ id: 5020008, rank: 5, isGuarantee: false }],
    rolls([0.2]),
  ),
  {
    isErupt: true,
    draws: [
      { equipmentId: 5020008, treasureUpType: 0 },
    ],
  },
);

function rolls(values) {
  let index = 0;
  return () => {
    if (index >= values.length) {
      throw new Error(`missing roll at index ${index}`);
    }
    return values[index++];
  };
}

assert.deepStrictEqual(
  computeEquipmentGachaMovieEffects(
    [
      { id: 4030003, rank: 4, isGuarantee: false },
      { id: 3050002, rank: 3, isGuarantee: false },
    ],
    normalProbability,
    rolls([0.19]),
  ),
  {
    isErupt: false,
    draws: [
      { equipmentId: 4030003, treasureUpType: 1 },
      { equipmentId: 3050002, treasureUpType: 0 },
    ],
  },
);

assert.deepStrictEqual(
  computeEquipmentGachaMovieEffects(
    [
      { id: 5020008, rank: 5, isGuarantee: false },
      { id: 4030003, rank: 4, isGuarantee: false },
    ],
    normalProbability,
    rolls([0.2]),
  ),
  {
    isErupt: true,
    draws: [
      { equipmentId: 5020008, treasureUpType: 0 },
      { equipmentId: 4030003, treasureUpType: 0 },
    ],
  },
);

assert.deepStrictEqual(
  computeEquipmentGachaMovieEffects(
    [
      { id: 4030003, rank: 4, isGuarantee: true },
    ],
    normalProbability,
    rolls([0.5, 0.3]),
  ),
  {
    isErupt: false,
    draws: [
      { equipmentId: 4030003, treasureUpType: 2 },
    ],
  },
);

console.log("gacha_equipment_movie tests passed");
