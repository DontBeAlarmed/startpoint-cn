const assert = require("assert");

const {
  getGachaTicketCost,
  GACHA_TICKET_ITEM_IDS,
} = require("../out/lib/gacha-ticket");

assert.deepStrictEqual(getGachaTicketCost(9, 1), {
  itemId: GACHA_TICKET_ITEM_IDS.characterMulti,
  useTicketCount: 1,
  pullCount: 10,
});

assert.deepStrictEqual(getGachaTicketCost(10, 1), {
  itemId: GACHA_TICKET_ITEM_IDS.characterSingle,
  useTicketCount: 1,
  pullCount: 1,
});

assert.deepStrictEqual(getGachaTicketCost(12, 1), {
  itemId: GACHA_TICKET_ITEM_IDS.equipmentSingle,
  useTicketCount: 1,
  pullCount: 1,
});

assert.deepStrictEqual(getGachaTicketCost(13, 1), {
  itemId: GACHA_TICKET_ITEM_IDS.equipmentMulti,
  useTicketCount: 1,
  pullCount: 10,
});

assert.strictEqual(getGachaTicketCost(11, 1), null);

console.log("gacha ticket mapping ok");
