const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const ABYSS_EVENT_ITEMS = require("../assets/event_item_shop.json")["11"]["700099"];
const BOSS_COIN_ITEMS = {
  200103: require("../assets/boss_coin_shop.json")["1"]["200103"],
  200117: require("../assets/boss_coin_shop.json")["1"]["200117"],
};

const ShopType = {
  EVENT_ITEM: 4,
  BOSS_COIN: 7,
  GENERAL: 8,
  TREASURE_EQUIPMENT: 10,
};

const ShopItemUserCostType = {
  BEADS: 0,
  MANA: 1,
  AMITY_SCROLL: 2,
};

const ShopItemRewardType = {
  ITEM: 0,
  EXP: 1,
  MANA: 2,
  CHARACTER: 3,
  EQUIPMENT: 4,
};

const RewardType = {
  ITEM: 0,
  EQUIPMENT: 1,
  CHARACTER: 2,
  BEADS: 3,
  MANA: 4,
  EXP: 5,
};

const SHOP_ITEMS = {
  9700101: {
    costs: [{ id: 2370099, amount: 10 }],
    rewards: [{ type: ShopItemRewardType.EQUIPMENT, id: 8000101, count: 1 }],
    availableFrom: "2026-07-01 00:00:00",
    availableUntil: "2099-12-31 23:59:59",
    stock: 5,
  },
  9700102: {
    costs: [{ id: 2370099, amount: 15 }],
    rewards: [{ type: ShopItemRewardType.EQUIPMENT, id: 8000102, count: 2 }],
    availableFrom: "2026-07-01 00:00:00",
    availableUntil: "2099-12-31 23:59:59",
    stock: 5,
  },
  9700103: {
    costs: [{ id: 2370099, amount: 10 }],
    rewards: [{ type: ShopItemRewardType.EQUIPMENT, id: 8000103, count: 1 }],
    availableFrom: "2026-07-01 00:00:00",
    availableUntil: "2099-12-31 23:59:59",
    stock: 0,
  },
};

const TREASURE_EQUIPMENT_ITEMS = {
  9800101: {
    costs: [{ id: 2370099, amount: 10 }],
    rewards: [],
    availableFrom: "2026-07-01 00:00:00",
    availableUntil: "2099-12-31 23:59:59",
    stock: 5,
    equipmentId: 8000101,
    enhancementMaxLevel: 5,
  },
};

function compiled(relativePath) {
  return path.join(ROOT, "out", relativePath);
}

function mockModule(relativePath, exports) {
  const filename = require.resolve(compiled(relativePath));
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
}

function snapshotState(state) {
  return {
    player: { ...state.player },
    items: new Map(state.items),
    equipment: new Map(state.equipment),
    purchases: new Map(state.purchases),
  };
}

function restoreMap(target, source) {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function restoreState(state, snapshot) {
  for (const key of Object.keys(state.player)) delete state.player[key];
  Object.assign(state.player, snapshot.player);
  restoreMap(state.items, snapshot.items);
  restoreMap(state.equipment, snapshot.equipment);
  restoreMap(state.purchases, snapshot.purchases);
}

async function createHarness({
  token = 100,
  purchases = {},
  shopItems = SHOP_ITEMS,
  bossCoinShopItems = BOSS_COIN_ITEMS,
  treasureEquipmentItems = TREASURE_EQUIPMENT_ITEMS,
  initialItems = {},
  failDuringReward = false,
} = {}) {
  const state = {
    player: {
      id: 11,
      freeMana: 500,
      freeVmoney: 600,
      bondToken: 7,
      expPool: 0,
    },
    items: new Map([
      [2370099, token],
      ...Object.entries(initialItems).map(([id, count]) => [Number(id), count]),
    ]),
    equipment: new Map(),
    purchases: new Map(
      Object.entries(purchases).map(([id, count]) => [Number(id), count]),
    ),
  };

  const transactionDb = {
    transaction(fn) {
      return () => {
        const before = snapshotState(state);
        try {
          return fn();
        } catch (error) {
          restoreState(state, before);
          throw error;
        }
      };
    },
  };

  mockModule("data/db.js", { getDb: () => transactionDb });
  mockModule("data/domains/shopPurchase.js", {
    getPlayerShopPurchasesMapSync: () => Object.fromEntries(state.purchases),
    getPlayerShopPurchaseCountSync: (_playerId, shopItemId) =>
      state.purchases.get(Number(shopItemId)) ?? 0,
    addPlayerShopPurchaseSync: (_playerId, shopItemId) => {
      const id = Number(shopItemId);
      const next = (state.purchases.get(id) ?? 0) + 1;
      state.purchases.set(id, next);
      return next;
    },
  });
  mockModule("data/domains/equipment.js", {
    getPlayerEquipmentSync: () => null,
    playerOwnsEquipmentSync: () => false,
    updatePlayerEquipmentSync: () => undefined,
  });
  mockModule("data/domains/item.js", {
    getPlayerItemSync: (_playerId, itemId) =>
      state.items.has(Number(itemId)) ? state.items.get(Number(itemId)) : null,
    updatePlayerItemSync: (_playerId, itemId, amount) =>
      state.items.set(Number(itemId), amount),
  });
  mockModule("data/domains/player.js", {
    getPlayerSync: () => ({ ...state.player }),
    updatePlayerSync: (patch) => Object.assign(state.player, patch),
  });
  mockModule("data/domains/session.js", {
    getSession: async () => ({ accountId: 1 }),
  });
  mockModule("data/activeAccount.js", {
    resolvePlayerIdSync: () => 11,
  });
  mockModule("lib/assets.js", {
    getShopItemSync: (shopType, shopItemId) => {
      const catalogs = {
        [ShopType.EVENT_ITEM]: shopItems,
        [ShopType.BOSS_COIN]: bossCoinShopItems,
        [ShopType.TREASURE_EQUIPMENT]: treasureEquipmentItems,
      };
      return catalogs[shopType]?.[Number(shopItemId)] ?? null;
    },
    getGenericShopItemsSync: () => null,
    getEventShopItemsSync: () => null,
    getBossCoinShopItemsSync: () => null,
    getConfigSync: () => ({
      stamina_recovery_virtual_money: 50,
      stamina_recovery_value: 100,
      max_stamina_overflow: 999,
    }),
  });
  mockModule("lib/types.js", {
    RewardType,
    ShopItemRewardType,
    ShopItemUserCostType,
    ShopType,
  });
  mockModule("utils.js", {
    generateDataHeaders: ({ viewer_id }) => ({ viewer_id }),
    getServerDate: () => new Date("2026-07-14T00:00:00.000Z"),
    getServerTime: () => Date.now(),
    realToVirtual: (value) => value,
  });
  mockModule("lib/stamina.js", {
    computeRealTimeStamina: () => 0,
  });
  mockModule("lib/equipment.js", {
    clientSerializeEquipment: (equipmentId, equipment) => ({
      equipment_id: equipmentId,
      ...equipment,
    }),
  });
  mockModule("lib/quest.js", {
    givePlayerRewardsSync: (_playerId, rewards) => {
      const equipmentList = [];
      const itemList = {};
      let mana = 0;
      let vmoney = 0;
      let expPool = 0;

      for (const reward of rewards) {
        if (reward.type === RewardType.EQUIPMENT) {
          const total = (state.equipment.get(reward.id) ?? 0) + reward.count;
          state.equipment.set(reward.id, total);
          if (failDuringReward) throw new Error("injected reward failure");
          equipmentList.push({
            equipment_id: reward.id,
            level: 1,
            enhancement_level: 0,
            protection: false,
            stack: total - 1,
          });
        } else if (reward.type === RewardType.ITEM) {
          const total = (state.items.get(reward.id) ?? 0) + reward.count;
          state.items.set(reward.id, total);
          // Match the production helper exactly: it adds each absolute
          // post-write total, which exposes duplicate reward IDs unless the
          // route consolidates them before calling givePlayerRewardsSync.
          itemList[reward.id] = (itemList[reward.id] ?? 0) + total;
        } else if (reward.type === RewardType.MANA) {
          state.player.freeMana += reward.count;
          mana += reward.count;
        } else if (reward.type === RewardType.BEADS) {
          state.player.freeVmoney += reward.count;
          vmoney += reward.count;
        } else if (reward.type === RewardType.EXP) {
          state.player.expPool += reward.count;
          expPool += reward.count;
        }
      }

      return {
        user_info: {
          free_mana: mana,
          free_vmoney: vmoney,
          exp_pool: expPool,
        },
        character_list: [],
        joined_character_id_list: [],
        equipment_list: equipmentList,
        items: itemList,
      };
    },
  });

  const routePath = require.resolve(compiled("routes/api/shop.js"));
  delete require.cache[routePath];
  const routes = require(routePath).default;
  const fastify = require("fastify")({ logger: false });
  fastify.addHook("onSend", (_request, _reply, payload, done) => {
    if (payload !== null && typeof payload === "object" && !Buffer.isBuffer(payload)) {
      done(null, JSON.stringify(payload));
      return;
    }
    done(null, payload);
  });
  await fastify.register(routes, { prefix: "/shop" });
  await fastify.ready();

  return {
    state,
    app: fastify,
    async close() {
      await fastify.close();
    },
  };
}

function body(buyItemList, shopType = ShopType.EVENT_ITEM) {
  return {
    viewer_id: 99,
    api_count: 1,
    shop_type: shopType,
    buy_item_list: buyItemList,
  };
}

test("event-item bulk_buy applies quantities, total cost, stock counts, and equipment rewards", async () => {
  const harness = await createHarness({ token: 100 });
  try {
    const response = await harness.app.inject({
      method: "POST",
      url: "/shop/bulk_buy",
      payload: body({ 9700101: 2, 9700102: 3 }),
    });

    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(harness.state.items.get(2370099), 35);
    assert.equal(harness.state.purchases.get(9700101), 2);
    assert.equal(harness.state.purchases.get(9700102), 3);
    assert.equal(harness.state.equipment.get(8000101), 2);
    assert.equal(harness.state.equipment.get(8000102), 6);

    const payload = JSON.parse(response.payload);
    assert.equal(payload.data.item_list[2370099], 35);
    assert.deepEqual(
      payload.data.equipment_list.map((entry) => entry.equipment_id).sort(),
      [8000101, 8000102],
    );
  } finally {
    await harness.close();
  }
});

test("event-item bulk_buy rejects numeric aliases that combine past stock", async () => {
  const harness = await createHarness({ token: 100 });
  try {
    const response = await harness.app.inject({
      method: "POST",
      url: "/shop/bulk_buy",
      payload: body({ 9700101: 3, "09700101": 3 }),
    });

    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(harness.state.items.get(2370099), 100);
    assert.equal(harness.state.purchases.size, 0);
    assert.equal(harness.state.equipment.size, 0);
  } finally {
    await harness.close();
  }
});

test("event-item bulk_buy treats stock zero as sold out", async () => {
  const harness = await createHarness({ token: 100 });
  try {
    const response = await harness.app.inject({
      method: "POST",
      url: "/shop/bulk_buy",
      payload: body({ 9700103: 1 }),
    });

    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(harness.state.items.get(2370099), 100);
    assert.equal(harness.state.purchases.size, 0);
    assert.equal(harness.state.equipment.size, 0);
  } finally {
    await harness.close();
  }
});

test("abyss event-item bulk_buy exchanges all 15 max-stock weapons for the full 825-token price", async () => {
  const harness = await createHarness({
    token: 825,
    shopItems: ABYSS_EVENT_ITEMS,
  });
  try {
    const buyItemList = Object.fromEntries(
      Object.keys(ABYSS_EVENT_ITEMS).map((shopItemId) => [shopItemId, 5]),
    );
    const response = await harness.app.inject({
      method: "POST",
      url: "/shop/bulk_buy",
      payload: body(buyItemList),
    });

    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(harness.state.items.get(2370099), 0);
    assert.equal(harness.state.purchases.size, 15);
    assert.equal(harness.state.equipment.size, 15);
    for (let equipmentId = 8000101; equipmentId <= 8000115; equipmentId++) {
      assert.equal(harness.state.equipment.get(equipmentId), 5);
    }
    for (const shopItemId of Object.keys(ABYSS_EVENT_ITEMS)) {
      assert.equal(harness.state.purchases.get(Number(shopItemId)), 5);
    }
  } finally {
    await harness.close();
  }
});

test("boss-coin bulk_buy consolidates duplicate ITEM rewards before the production helper", async () => {
  const harness = await createHarness({
    initialItems: { 40000: 1, 40001: 1, 13: 1 },
  });
  try {
    const response = await harness.app.inject({
      method: "POST",
      url: "/shop/bulk_buy",
      payload: body({ 200103: 1, 200117: 1 }, ShopType.BOSS_COIN),
    });

    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(harness.state.items.get(40000), 0);
    assert.equal(harness.state.items.get(40001), 0);
    assert.equal(harness.state.items.get(13), 5);
    assert.equal(harness.state.purchases.get(200103), 1);
    assert.equal(harness.state.purchases.get(200117), 1);
    assert.equal(JSON.parse(response.payload).data.item_list[13], 5);
  } finally {
    await harness.close();
  }
});

test("boss-coin bulk_buy is atomic when one selected currency is insufficient", async () => {
  const harness = await createHarness({
    initialItems: { 40000: 1, 40001: 0, 13: 1 },
  });
  try {
    const response = await harness.app.inject({
      method: "POST",
      url: "/shop/bulk_buy",
      payload: body({ 200103: 1, 200117: 1 }, ShopType.BOSS_COIN),
    });

    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(harness.state.items.get(40000), 1);
    assert.equal(harness.state.items.get(40001), 0);
    assert.equal(harness.state.items.get(13), 1);
    assert.equal(harness.state.purchases.size, 0);
  } finally {
    await harness.close();
  }
});

test("bulk_buy rejects treasure-equipment shop type before deducting costs", async () => {
  const harness = await createHarness({ token: 100 });
  try {
    const response = await harness.app.inject({
      method: "POST",
      url: "/shop/bulk_buy",
      payload: body({ 9800101: 1 }, ShopType.TREASURE_EQUIPMENT),
    });

    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(harness.state.items.get(2370099), 100);
    assert.equal(harness.state.purchases.size, 0);
    assert.equal(harness.state.equipment.size, 0);
  } finally {
    await harness.close();
  }
});

test("event-item bulk_buy rejects a selection that exceeds stock without partial writes", async () => {
  const harness = await createHarness({
    token: 100,
    purchases: { 9700101: 4 },
  });
  try {
    const response = await harness.app.inject({
      method: "POST",
      url: "/shop/bulk_buy",
      payload: body({ 9700101: 2, 9700102: 1 }),
    });

    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(harness.state.items.get(2370099), 100);
    assert.equal(harness.state.purchases.get(9700101), 4);
    assert.equal(harness.state.purchases.has(9700102), false);
    assert.equal(harness.state.equipment.size, 0);
  } finally {
    await harness.close();
  }
});

test("event-item bulk_buy rolls back the whole selection when the combined balance is insufficient", async () => {
  const harness = await createHarness({ token: 20 });
  try {
    const response = await harness.app.inject({
      method: "POST",
      url: "/shop/bulk_buy",
      payload: body({ 9700101: 1, 9700102: 1 }),
    });

    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(harness.state.items.get(2370099), 20);
    assert.equal(harness.state.purchases.size, 0);
    assert.equal(harness.state.equipment.size, 0);
  } finally {
    await harness.close();
  }
});

test("event-item bulk_buy rolls back costs and rewards when a later DB operation fails", async () => {
  const harness = await createHarness({
    token: 100,
    failDuringReward: true,
  });
  try {
    const originalConsoleError = console.error;
    let response;
    try {
      console.error = () => undefined;
      response = await harness.app.inject({
        method: "POST",
        url: "/shop/bulk_buy",
        payload: body({ 9700101: 1, 9700102: 1 }),
      });
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(response.statusCode, 500, response.payload);
    assert.equal(harness.state.items.get(2370099), 100);
    assert.equal(harness.state.purchases.size, 0);
    assert.equal(harness.state.equipment.size, 0);
  } finally {
    await harness.close();
  }
});
