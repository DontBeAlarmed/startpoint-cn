const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const rushEvent = require(path.resolve(__dirname, "../out/routes/api/rushEvent.js"));

function party(name) {
  return {
    abilitySoulIds: [null, null, null],
    characterIds: [111001, null, null],
    equipmentIds: [null, null, null],
    unisonCharacterIds: [null, null, null],
    options: { allowOtherPlayersToHealMe: true },
    edited: true,
    name,
  };
}

test("Rush party serialization uses globally unique party IDs across groups", () => {
  assert.equal(typeof rushEvent.serializeRushPartyGroups, "function");

  const groups = {
    1: { colorId: 1, list: { 1: party("g1s1"), 5: party("g1s5") } },
    2: { colorId: 2, list: { 1: party("g2s1") } },
    3: { colorId: 3, list: { 5: party("g3s5") } },
    12: { colorId: 12, list: { 10: party("g12s10") } },
  };

  const serialized = rushEvent.serializeRushPartyGroups(groups);
  const byGroup = Object.fromEntries(
    serialized.map((group) => [group.party_group_id, group.party_list]),
  );

  assert.deepEqual(byGroup[1].map((value) => value.party_id), [1, 5]);
  assert.deepEqual(byGroup[2].map((value) => value.party_id), [11]);
  assert.deepEqual(byGroup[3].map((value) => value.party_id), [25]);
  assert.deepEqual(byGroup[12].map((value) => value.party_id), [120]);
  assert.equal(byGroup[3][0].party_name, "g3s5");
});
