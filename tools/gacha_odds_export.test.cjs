const assert = require("assert");
const path = require("path");

const {
  collectOddsIds,
  findDefaultUploadStore,
  hashOddsPath,
  readOddsFile,
} = require("./gacha_odds_export.cjs");

const root = path.resolve(__dirname, "..");
const store = findDefaultUploadStore(root);

if (!store) {
  console.log("gacha_odds_export tests skipped: WorldFlipper production/upload not found");
  process.exit(0);
}

assert.strictEqual(
  hashOddsPath("new_character_pickup_25_character_5").relativePath,
  "b5/d3cc4701dad0919273552345fb019987d21692",
);

assert.strictEqual(
  hashOddsPath("revival_fes_1_character_5").relativePath,
  "4e/8f16a44b009388086a8c20175a693fbc598eac",
);

const rarity = readOddsFile(store, "normal_rarity", "rarity");
assert.deepStrictEqual(rarity.entries, [
  { rarity: 5, weight: 5 },
  { rarity: 4, weight: 25 },
  { rarity: 3, weight: 70 },
]);

const character = readOddsFile(store, "new_character_pickup_25_character_5", "character");
assert.strictEqual(character.entries.length, 44);
assert.strictEqual(character.entries.reduce((sum, item) => sum + item.weight, 0), 430);
assert.deepStrictEqual(character.entries[0], {
  characterId: 121015,
  rarity: 5,
  weight: 129,
  oddsUp: true,
  isLimited: false,
  isExchangeable: true,
  trialReadingForced: false,
});

const equipment = readOddsFile(store, "equipment_wind_pickup_1_5", "equipment");
assert.strictEqual(equipment.entries.length, 15);
assert.deepStrictEqual(equipment.entries[0], {
  equipmentId: 5100002,
  rarity: 5,
  weight: 13,
  oddsUp: true,
  isLimited: false,
  isExchangeable: true,
});

const gachaRows = require("../assets/cdndata/gacha.json");
const ids = collectOddsIds(gachaRows);
assert.ok(ids.rarity.has("normal_rarity"));
assert.ok(ids.rarity.has("equipment_normal_rarity"));
assert.ok(ids.character.has("revival_fes_1_character_5"));
assert.ok(ids.equipment.has("equipment_wind_pickup_1_5"));
assert.ok(!ids.character.has(""));
assert.ok(!ids.equipment.has("(None)"));

console.log("gacha_odds_export tests passed");
