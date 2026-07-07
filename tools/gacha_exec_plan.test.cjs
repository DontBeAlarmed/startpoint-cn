require("ts-node/register");

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
    execType: GACHA_EXEC_TYPES.MULTI_TICKET,
    numberOfExec: 2,
    playerFunds,
    playerGachaData,
    getTicketCount: (itemId) => itemId === 20002 ? 2 : 0,
  }),
  {
    ok: true,
    plan: {
      pullCount: 20,
      freeVmoney: 1000,
      paidVmoney: 800,
      ticket: {
        itemId: 20002,
        beforeCount: 2,
        afterCount: 0,
        useTicketCount: 2,
      },
      campaign: null,
    },
  },
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
    paymentType: GACHA_PAYMENT_TYPES.FREE_VMONEY,
    execType: GACHA_EXEC_TYPES.VMONEY_MULTI,
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

console.log("gacha_exec_plan tests passed");
