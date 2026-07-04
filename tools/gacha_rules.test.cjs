require("ts-node/register");

const assert = require("assert");

const {
  getGachaTicketCost,
} = require("../src/lib/gacha-ticket.ts");
const {
  GACHA_EXEC_TYPES,
  GACHA_PAGE_KINDS,
  GACHA_PAYMENT_TYPES,
  getExchangeableGachaItem,
  isGachaExecAllowed,
} = require("../src/lib/gacha-rules.ts");

const characterGacha = {
  type: 0,
  pageKind: GACHA_PAGE_KINDS.NORMAL,
  onceTicketItemId: 20001,
  tenTicketItemId: 20002,
  wildcardTicketAvailable: false,
  pool: {
    "1": [
      { id: 111001, isExchangeable: true },
      { id: 111002, isExchangeable: false },
    ],
  },
};

assert.deepStrictEqual(getGachaTicketCost(GACHA_EXEC_TYPES.SINGLE_TICKET, 1, characterGacha), {
  itemId: 20001,
  useTicketCount: 1,
  pullCount: 1,
});
assert.deepStrictEqual(getGachaTicketCost(GACHA_EXEC_TYPES.MULTI_TICKET, 2, characterGacha), {
  itemId: 20002,
  useTicketCount: 2,
  pullCount: 20,
});
assert.strictEqual(getGachaTicketCost(GACHA_EXEC_TYPES.SINGLE_WEAPON_TICKET, 1, characterGacha), null);

const wildcardCharacterGacha = {
  type: 0,
  pageKind: GACHA_PAGE_KINDS.NORMAL,
  wildcardTicketAvailable: true,
  pool: {},
};
assert.strictEqual(
  getGachaTicketCost(GACHA_EXEC_TYPES.SINGLE_TICKET, 1, wildcardCharacterGacha).itemId,
  999003,
);

const noTicketGacha = {
  type: 0,
  pageKind: GACHA_PAGE_KINDS.NORMAL,
  wildcardTicketAvailable: false,
  pool: {},
};
assert.strictEqual(getGachaTicketCost(GACHA_EXEC_TYPES.SINGLE_TICKET, 1, noTicketGacha), null);

const equipmentGacha = {
  type: 1,
  pageKind: GACHA_PAGE_KINDS.NORMAL,
  onceTicketItemId: 20005,
  tenTicketItemId: 20006,
  wildcardTicketAvailable: false,
  pool: {
    "1": [
      { id: 5020008, isExchangeable: true },
    ],
  },
};
assert.deepStrictEqual(getGachaTicketCost(GACHA_EXEC_TYPES.SINGLE_WEAPON_TICKET, 1, equipmentGacha), {
  itemId: 20005,
  useTicketCount: 1,
  pullCount: 1,
});
assert.strictEqual(getGachaTicketCost(GACHA_EXEC_TYPES.SINGLE_TICKET, 1, equipmentGacha), null);

assert.strictEqual(getExchangeableGachaItem(characterGacha, 111001).id, 111001);
assert.strictEqual(getExchangeableGachaItem(characterGacha, 111002), null);
assert.strictEqual(getExchangeableGachaItem(characterGacha, 999999), null);

const oneTimeTicketOnly = {
  ...characterGacha,
  pageKind: GACHA_PAGE_KINDS.ONE_TIME_TICKET_ONLY,
};
assert.strictEqual(
  isGachaExecAllowed(oneTimeTicketOnly, GACHA_PAYMENT_TYPES.TICKET, GACHA_EXEC_TYPES.SINGLE_TICKET),
  true,
);
assert.strictEqual(
  isGachaExecAllowed(oneTimeTicketOnly, GACHA_PAYMENT_TYPES.TICKET, GACHA_EXEC_TYPES.MULTI_TICKET),
  false,
);
assert.strictEqual(
  isGachaExecAllowed(oneTimeTicketOnly, GACHA_PAYMENT_TYPES.FREE_VMONEY, GACHA_EXEC_TYPES.VMONEY_SINGLE),
  false,
);

const tenTicketOnly = {
  ...characterGacha,
  pageKind: GACHA_PAGE_KINDS.TEN_TIMES_TICKET_ONLY,
};
assert.strictEqual(
  isGachaExecAllowed(tenTicketOnly, GACHA_PAYMENT_TYPES.TICKET, GACHA_EXEC_TYPES.MULTI_TICKET),
  true,
);
assert.strictEqual(
  isGachaExecAllowed(tenTicketOnly, GACHA_PAYMENT_TYPES.TICKET, GACHA_EXEC_TYPES.SINGLE_TICKET),
  false,
);

const withoutDaily = {
  ...characterGacha,
  pageKind: GACHA_PAGE_KINDS.WITHOUT_DAILY,
};
assert.strictEqual(
  isGachaExecAllowed(withoutDaily, GACHA_PAYMENT_TYPES.VMONEY, GACHA_EXEC_TYPES.DAILY_SINGLE),
  false,
);
assert.strictEqual(
  isGachaExecAllowed(withoutDaily, GACHA_PAYMENT_TYPES.FREE_VMONEY, GACHA_EXEC_TYPES.VMONEY_SINGLE),
  true,
);

console.log("gacha_rules tests passed");
