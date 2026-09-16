require("ts-node/register/transpile-only");

const assert = require("assert");

const {
  buildGachaExecPlan,
} = require("../src/lib/gacha-exec-plan.ts");
const {
  GACHA_EXEC_TYPES,
  GACHA_PAGE_KINDS,
  GACHA_PAYMENT_TYPES,
} = require("../src/lib/gacha-rules.ts");

const characterGacha = {
  type: 0,
  pageKind: GACHA_PAGE_KINDS.NORMAL,
  singleCost: 150,
  multiCost: 1500,
  discountCost: 0,
  onceTicketItemId: 20001,
  tenTicketItemId: 20002,
  wildcardTicketAvailable: false,
  pool: {},
};

const equipmentGacha = {
  ...characterGacha,
  type: 1,
  singleCost: 75,
  multiCost: 750,
  discountCost: 25,
  onceTicketItemId: 20005,
  tenTicketItemId: 20006,
};

const playerGachaData = {
  isAccountFirst: true,
  isDailyFirst: true,
  gachaExchangePoint: 0,
};

const playerFunds = {
  freeVmoney: 1000,
  paidVmoney: 800,
};

assert.deepStrictEqual(
  buildGachaExecPlan({
    gacha: characterGacha,
    paymentType: GACHA_PAYMENT_TYPES.FREE_VMONEY,
    execType: GACHA_EXEC_TYPES.VMONEY_MULTI,
    numberOfExec: 1,
    playerFunds,
    playerGachaData,
  }),
  {
    ok: true,
    plan: {
      pullCount: 10,
      freeVmoney: 0,
      paidVmoney: 300,
      ticket: null,
      campaign: null,
    },
  },
);

assert.deepStrictEqual(
  buildGachaExecPlan({
    gacha: equipmentGacha,
    paymentType: GACHA_PAYMENT_TYPES.VMONEY,
    execType: GACHA_EXEC_TYPES.DAILY_SINGLE,
    numberOfExec: 1,
    playerFunds: { freeVmoney: 0, paidVmoney: 30 },
    playerGachaData,
  }),
  {
    ok: true,
    plan: {
      pullCount: 1,
      freeVmoney: 0,
      paidVmoney: 5,
      ticket: null,
      campaign: null,
    },
  },
);

assert.deepStrictEqual(
  buildGachaExecPlan({
    gacha: characterGacha,
    paymentType: GACHA_PAYMENT_TYPES.TICKET,
    execType: GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET,
    numberOfExec: 2,
    playerFunds,
    playerGachaData,
    getTicketCount: (itemId) => itemId === 20002 ? 2 : 0,
  }),
  { ok: false, status: 400, message: "Invalid number of gacha executions." },
);

assert.deepStrictEqual(
  buildGachaExecPlan({
    gacha: characterGacha,
    paymentType: GACHA_PAYMENT_TYPES.CAMPAIGN,
    execType: GACHA_EXEC_TYPES.CAMPAIGN_MULTI,
    numberOfExec: 1,
    playerFunds,
    playerGachaData,
    getCampaignState: () => ({
      campaignId: 77,
      count: 1,
      insert: false,
    }),
  }),
  {
    ok: true,
    plan: {
      pullCount: 10,
      freeVmoney: 1000,
      paidVmoney: 800,
      ticket: null,
      campaign: {
        campaignId: 77,
        count: 0,
        insert: false,
      },
    },
  },
);

assert.deepStrictEqual(
  buildGachaExecPlan({
    gacha: {
      ...characterGacha,
      pageKind: GACHA_PAGE_KINDS.TEN_TIMES_PER_ACCOUNT,
      tenTimesPerAccountCost: 1000,
    },
    paymentType: GACHA_PAYMENT_TYPES.VMONEY,
    execType: GACHA_EXEC_TYPES.ACCOUNT_PAID_MULTI,
    numberOfExec: 1,
    playerFunds,
    playerGachaData: {
      ...playerGachaData,
      isAccountFirst: false,
    },
  }),
  {
    ok: false,
    status: 400,
    message: "Already did account-limited summon.",
  },
);

assert.deepStrictEqual(
  buildGachaExecPlan({
    gacha: {
      ...characterGacha,
      pageKind: GACHA_PAGE_KINDS.TEN_TIMES_PER_ACCOUNT,
      tenTimesPerAccountCost: 600,
    },
    paymentType: GACHA_PAYMENT_TYPES.VMONEY,
    execType: GACHA_EXEC_TYPES.ACCOUNT_PAID_MULTI,
    numberOfExec: 1,
    playerFunds,
    playerGachaData,
  }),
  {
    ok: true,
    plan: {
      pullCount: 10,
      freeVmoney: 1000,
      paidVmoney: 200,
      ticket: null,
      campaign: null,
    },
  },
);

for (const [paymentType, execType] of [
  [GACHA_PAYMENT_TYPES.FREE_VMONEY, GACHA_EXEC_TYPES.DAILY_SINGLE],
  [GACHA_PAYMENT_TYPES.VMONEY, GACHA_EXEC_TYPES.VMONEY_MULTI],
  [GACHA_PAYMENT_TYPES.CAMPAIGN, GACHA_EXEC_TYPES.VMONEY_SINGLE],
  [GACHA_PAYMENT_TYPES.FREE_VMONEY, GACHA_EXEC_TYPES.CAMPAIGN_MULTI],
]) {
  assert.deepStrictEqual(buildGachaExecPlan({
    gacha: characterGacha,
    paymentType,
    execType,
    numberOfExec: 1,
    playerFunds,
    playerGachaData,
  }), {
    ok: false,
    status: 400,
    message: "Gacha execution type is not allowed for this gacha.",
  });
}

console.log("gacha_exec_plan tests passed");

// B4: 配置票不足时按 wildcardTicketAvailable 回退通用票
const wildcardCharacterGacha = { ...characterGacha, wildcardTicketAvailable: true };
const {
  GACHA_TICKET_ITEM_IDS,
} = require("../src/lib/gacha-ticket.ts");

assert.deepStrictEqual(
  buildGachaExecPlan({
    gacha: wildcardCharacterGacha,
    paymentType: GACHA_PAYMENT_TYPES.TICKET,
    execType: GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET,
    numberOfExec: 1,
    playerFunds,
    playerGachaData,
    getTicketCount: itemId => itemId === 20002 ? 0 : itemId === GACHA_TICKET_ITEM_IDS.characterMulti ? 1 : 0,
  }),
  {
    ok: true,
    plan: {
      pullCount: 10,
      freeVmoney: playerFunds.freeVmoney,
      paidVmoney: playerFunds.paidVmoney,
      ticket: {
        itemId: GACHA_TICKET_ITEM_IDS.characterMulti,
        beforeCount: 1,
        afterCount: 0,
        useTicketCount: 1,
      },
      campaign: null,
    },
  },
  "配置票不足且允许 wildcard 时应回退通用票",
);

assert.deepStrictEqual(
  buildGachaExecPlan({
    gacha: characterGacha, // wildcardTicketAvailable: false
    paymentType: GACHA_PAYMENT_TYPES.TICKET,
    execType: GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET,
    numberOfExec: 1,
    playerFunds,
    playerGachaData,
    getTicketCount: itemId => itemId === 20002 ? 0 : itemId === GACHA_TICKET_ITEM_IDS.characterMulti ? 1 : 0,
  }),
  { ok: false, status: 400, message: "Not enough tickets." },
  "不允许 wildcard 时禁止回退",
);

assert.deepStrictEqual(
  buildGachaExecPlan({
    gacha: wildcardCharacterGacha,
    paymentType: GACHA_PAYMENT_TYPES.TICKET,
    execType: GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET,
    numberOfExec: 1,
    playerFunds,
    playerGachaData,
    getTicketCount: () => 0,
  }),
  { ok: false, status: 400, message: "Not enough tickets." },
  "配置票与通用票都不足时失败",
);

assert.deepStrictEqual(
  buildGachaExecPlan({
    gacha: { ...wildcardCharacterGacha, type: 1, onceTicketItemId: 20005, tenTicketItemId: 20006 },
    paymentType: GACHA_PAYMENT_TYPES.TICKET,
    execType: GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET,
    numberOfExec: 1,
    playerFunds,
    playerGachaData,
    getTicketCount: itemId => itemId === 20006 ? 0 : itemId === GACHA_TICKET_ITEM_IDS.equipmentMulti ? 2 : 0,
  }),
  {
    ok: true,
    plan: {
      pullCount: 10,
      freeVmoney: playerFunds.freeVmoney,
      paidVmoney: playerFunds.paidVmoney,
      ticket: {
        itemId: GACHA_TICKET_ITEM_IDS.equipmentMulti,
        beforeCount: 2,
        afterCount: 1,
        useTicketCount: 1,
      },
      campaign: null,
    },
  },
  "装备池配置票不足应回退装备通用票",
);

assert.deepStrictEqual(
  buildGachaExecPlan({
    gacha: wildcardCharacterGacha,
    paymentType: GACHA_PAYMENT_TYPES.TICKET,
    execType: GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET,
    numberOfExec: 1,
    playerFunds,
    playerGachaData,
    getTicketCount: itemId => itemId === 20002 ? 1 : 0,
  }),
  {
    ok: true,
    plan: {
      pullCount: 10,
      freeVmoney: playerFunds.freeVmoney,
      paidVmoney: playerFunds.paidVmoney,
      ticket: {
        itemId: 20002,
        beforeCount: 1,
        afterCount: 0,
        useTicketCount: 1,
      },
      campaign: null,
    },
  },
  "配置票足够时优先使用配置票",
);

console.log("gacha exec plan tests passed");
