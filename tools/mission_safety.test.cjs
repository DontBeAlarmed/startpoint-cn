require("ts-node/register");

const assert = require("assert");

const { getMissionIdsByCategory } = require("../src/lib/mission/stages.ts");
const { isMissionEnabledAt } = require("../src/lib/mission/patterns.ts");
const { validateMissionRewardClaims } = require("../src/lib/mission/claims.ts");

const currentServerDate = new Date("2024-08-14T12:00:00Z");
const activeDailyIds = getMissionIdsByCategory(2).filter((missionId) =>
  isMissionEnabledAt(2, missionId, currentServerDate),
);

assert(activeDailyIds.includes(11));
assert(activeDailyIds.includes(13));
assert(activeDailyIds.includes(14));
assert(!activeDailyIds.includes(3));
assert(!activeDailyIds.includes(10016));

const daily3Start = new Date("2019-11-28T03:00:00Z");
assert.strictEqual(isMissionEnabledAt(2, 3, new Date(daily3Start.getTime() - 1)), false);
assert.strictEqual(isMissionEnabledAt(2, 3, daily3Start), true);

const collectEventDate = new Date("2020-02-25T03:00:00Z");
assert.strictEqual(isMissionEnabledAt(4, 1500, collectEventDate, 1), true);
assert.strictEqual(isMissionEnabledAt(4, 1500, collectEventDate, 2), false);
assert.strictEqual(isMissionEnabledAt(4, 1500, collectEventDate), false);

const incompleteStoneClaim = validateMissionRewardClaims(
  { "11110": { progress: 9, stages: [] } },
  [{ mission_id: 11110, stages: [1] }],
);
assert.deepStrictEqual(incompleteStoneClaim, { ok: false, message: "Mission stage is not complete." });

const validStoneClaim = validateMissionRewardClaims(
  { "11110": { progress: 10, stages: [] } },
  [
    { mission_id: 11110, stages: [1, 1] },
    { mission_id: 11110, stages: [1] },
  ],
);
assert.strictEqual(validStoneClaim.ok, true);
assert.strictEqual(validStoneClaim.claims.length, 1);
assert.deepStrictEqual(validStoneClaim.claims[0].rewards, [{ kind: 0, amount: 300 }]);

const pendingStageClaim = validateMissionRewardClaims(
  { "11110": { progress: 0, stages: { "1": false } } },
  [{ mission_id: 11110, stages: [1] }],
);
assert.strictEqual(pendingStageClaim.ok, true);
assert.strictEqual(pendingStageClaim.claims.length, 1);

const receivedClaim = validateMissionRewardClaims(
  { "11110": { progress: 10, stages: { "1": true } } },
  [{ mission_id: 11110, stages: [1] }],
);
assert.deepStrictEqual(receivedClaim, { ok: true, claims: [] });

const unknownMissionClaim = validateMissionRewardClaims(
  {},
  [{ mission_id: 11110, stages: [1] }],
);
assert.deepStrictEqual(unknownMissionClaim, { ok: false, message: "Mission is not active." });

console.log("mission_safety tests passed");
