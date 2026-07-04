const assert = require("assert");

const {
  findDefaultUploadStore,
} = require("./gacha_odds_export.cjs");
const {
  buildGachaFromOdds,
  diffGacha,
} = require("./rebuild_gacha_from_odds.cjs");

if (!findDefaultUploadStore(process.cwd())) {
  console.log("rebuild_gacha_from_odds tests skipped: WorldFlipper production/upload not found");
  process.exit(0);
}

const generated = buildGachaFromOdds({ root: process.cwd() });

assert.strictEqual(Object.keys(generated).length, 584);

assert.strictEqual(generated["1"].type, 0);
assert.strictEqual(generated["1"].pageKind, 0);
assert.strictEqual(generated["1"].onceTicketItemId, 20001);
assert.strictEqual(generated["1"].tenTicketItemId, 20002);
assert.strictEqual(generated["1"].wildcardTicketAvailable, false);
assert.deepStrictEqual(generated["1"].rankRates, {
  normal: [50, 250, 700],
  multiGuarantee: [50, 950],
});
assert.deepStrictEqual(
  Object.fromEntries(Object.entries(generated["1"].pool).map(([key, items]) => [key, items.length])),
  { "1": 15, "2": 27, "3": 49 },
);
assert.deepStrictEqual(generated["1"].pool["1"][0], {
  id: 111001,
  rank: 5,
  odds: 1,
  isRateUp: false,
  isLimited: false,
  isExchangeable: false,
  trialReadingForced: false,
  rarity: 66.67,
});

assert.strictEqual(generated["3"].type, 1);
assert.strictEqual(generated["3"].pageKind, 0);
assert.strictEqual(generated["3"].onceTicketItemId, 20005);
assert.strictEqual(generated["3"].tenTicketItemId, 20006);
assert.strictEqual(generated["3"].wildcardTicketAvailable, false);
assert.strictEqual(generated["3"].equipmentMovieProbabilityId, "1");
assert.deepStrictEqual(generated["3"].rankRates, {
  normal: [50, 250, 700],
  multiGuarantee: [50, 950],
});
assert.deepStrictEqual(
  Object.fromEntries(Object.entries(generated["3"].pool).map(([key, items]) => [key, items.length])),
  { "1": 6, "2": 14, "3": 20 },
);
assert.deepStrictEqual(generated["3"].pool["1"][0], {
  id: 5020008,
  rank: 5,
  odds: 1,
  isRateUp: false,
  isLimited: false,
  isExchangeable: false,
  rarity: 166.67,
});

const pickup = generated["52"].pool["1"].find((item) => item.id === 121015);
assert.deepStrictEqual(pickup, {
  id: 121015,
  rank: 5,
  odds: 129,
  isRateUp: true,
  isLimited: false,
  isExchangeable: true,
  trialReadingForced: false,
  rarity: 300,
});

assert.deepStrictEqual(generated["2"].rankRates, {
  normal: [50, 950, 0],
  multiGuarantee: [50, 950],
});

assert.deepStrictEqual(generated["4"].rankRates, {
  normal: [1000, 0, 0],
  multiGuarantee: [1000, 0],
});

assert.deepStrictEqual(generated["800000"].rankRates, {
  normal: [50, 250, 700],
  multiGuarantee: [1000, 0],
});
assert.strictEqual(generated["800000"].pageKind, 1);
assert.strictEqual(generated["800000"].tenTimesPerAccountCost, 1500);

assert.deepStrictEqual(generated["157"].rankRates, {
  normal: [75, 250, 675],
  multiGuarantee: [75, 925],
});

const syntheticOld = JSON.parse(JSON.stringify(generated));
syntheticOld["1"].pool["1"].push({
  id: 199999,
  rank: 5,
  odds: 1,
  isRateUp: false,
  rarity: 1,
});
syntheticOld["1"].pool["1"][0].odds = 9;

const diff = diffGacha(syntheticOld, generated);
assert.strictEqual(diff.summary.compared, 584);
assert.ok(diff.banners["1"].pool["1"].count.old > diff.banners["1"].pool["1"].count.new);
assert.strictEqual(diff.banners["1"].pool["1"].count.new, 15);
assert.strictEqual(diff.banners["1"].pool["1"].removed[0], 199999);
assert.strictEqual(diff.banners["1"].pool["1"].changed[0].id, 111001);

console.log("rebuild_gacha_from_odds tests passed");
