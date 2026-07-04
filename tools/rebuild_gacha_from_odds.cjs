const fs = require("fs");
const path = require("path");

const { buildOddsExport } = require("./gacha_odds_export.cjs");

const DEFAULT_GACHA_PATH = path.join("assets", "gacha.json");
const DEFAULT_OLD_SNAPSHOT = path.join("out", "gacha_before_odds.json");
const DEFAULT_DIFF_PATH = path.join("out", "gacha_odds_diff.json");

function firstRow(rowGroup) {
  if (Array.isArray(rowGroup) && Array.isArray(rowGroup[0])) {
    return rowGroup[0];
  }
  if (Array.isArray(rowGroup)) {
    return rowGroup;
  }
  return null;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalInteger(value) {
  if (value == null) {
    return undefined;
  }
  const text = String(value).trim();
  if (!text || text === "(None)") {
    return undefined;
  }
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalBoolean(value, fallback = false) {
  if (value == null) {
    return fallback;
  }
  const text = String(value).trim().toLowerCase();
  if (!text || text === "(none)") {
    return fallback;
  }
  if (text === "true") {
    return true;
  }
  if (text === "false") {
    return false;
  }
  return fallback;
}

function cleanOptionalString(value) {
  if (value == null) {
    return undefined;
  }
  const text = String(value).trim();
  return text && text !== "(None)" ? text : undefined;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function normalizeWeightsToThousand(weights, totalWeight = null) {
  const total = totalWeight ?? weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    return weights.map(() => 0);
  }

  const exact = weights.map((weight) => (weight / total) * 1000);
  const normalized = exact.map((weight) => Math.floor(weight));
  let remainder = 1000 - normalized.reduce((sum, weight) => sum + weight, 0);
  const order = exact
    .map((weight, index) => ({ index, fraction: weight - Math.floor(weight) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let i = 0; i < order.length && remainder > 0; i += 1) {
    normalized[order[i].index] += 1;
    remainder -= 1;
  }

  return normalized;
}

function buildRankRates(rarityOdds, guaranteeRarity) {
  if (!rarityOdds) {
    throw new Error("missing rarity odds table");
  }

  const raw = new Map(rarityOdds.entries.map((entry) => [entry.rarity, entry.weight]));
  const totalWeight = rarityOdds.entries.reduce((sum, entry) => sum + entry.weight, 0);
  const normalWeights = [5, 4, 3].map((rarity) => raw.get(rarity) || 0);
  const guaranteeWeights = [5, 4].map((rarity) => {
    let weight = raw.get(rarity) || 0;
    if (rarity < guaranteeRarity) {
      weight = 0;
    }
    if (rarity === guaranteeRarity) {
      for (let lower = 1; lower < guaranteeRarity; lower += 1) {
        weight += raw.get(lower) || 0;
      }
    }
    return weight;
  });

  return {
    normal: normalizeWeightsToThousand(normalWeights, totalWeight),
    multiGuarantee: normalizeWeightsToThousand(guaranteeWeights, totalWeight),
  };
}

function poolKeyForRank(rank) {
  if (rank === 5) return "1";
  if (rank === 4) return "2";
  if (rank === 3) return "3";
  return String(6 - rank);
}

function normalizePoolEntries(entries, idField) {
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  return entries.map((entry) => {
    const item = {
      id: entry[idField],
      rank: entry.rarity,
      odds: entry.weight,
      isRateUp: entry.oddsUp,
      isLimited: entry.isLimited,
      isExchangeable: entry.isExchangeable,
      rarity: totalWeight > 0 ? round2((entry.weight / totalWeight) * 1000) : 0,
    };
    if (Object.prototype.hasOwnProperty.call(entry, "trialReadingForced")) {
      item.trialReadingForced = entry.trialReadingForced;
    }
    return item;
  });
}

function buildPoolForOddsIds(oddsTable, mapping, idField) {
  const pool = {};
  for (const [poolKey, oddsId] of Object.entries(mapping)) {
    if (!oddsId) {
      continue;
    }
    const odds = oddsTable[oddsId];
    if (!odds) {
      throw new Error(`missing loaded odds table: ${oddsId}`);
    }
    pool[poolKey] = normalizePoolEntries(odds.entries, idField);
  }
  return pool;
}

function buildBannerFromRow(gachaId, row, oddsExport) {
  const prizeKind = row[13];
  const isEquipment = prizeKind === "1";
  const name = String(row[1] || `Gacha ${gachaId}`);
  const pageKind = parseInteger(row[4], 0);
  const guaranteeRarity = parseInteger(row[10], 4);
  const rarityOddsId = String(row[11] || "");
  const rankRates = buildRankRates(oddsExport.rarity[rarityOddsId], guaranteeRarity);
  const singleCost = parseInteger(row[5], isEquipment ? 75 : 150);
  const multiCost = parseInteger(row[6], isEquipment ? 750 : 1500);
  const discountCost = parseInteger(row[7], isEquipment ? 25 : 50);
  const tenTimesPerAccountCost = parseOptionalInteger(row[8]);
  const onceTicketItemId = parseOptionalInteger(row[27]);
  const tenTicketItemId = parseOptionalInteger(row[28]);
  const startDate = String(row[29] || "2000-01-01 00:00:00");
  const endDate = String(row[30] || "2099-01-01 00:00:00");

  if (isEquipment) {
    return {
      type: 1,
      paymentType: 0,
      pageKind,
      singleCost,
      multiCost,
      discountCost,
      ...(tenTimesPerAccountCost ? { tenTimesPerAccountCost } : {}),
      ...(onceTicketItemId ? { onceTicketItemId } : {}),
      ...(tenTicketItemId ? { tenTicketItemId } : {}),
      wildcardTicketAvailable: parseOptionalBoolean(row[26]),
      rarityOddsId,
      guaranteeRarity,
      rankRates,
      ...(cleanOptionalString(row[25]) ? { equipmentMovieProbabilityId: cleanOptionalString(row[25]) } : {}),
      startDate,
      endDate,
      name,
      pool: buildPoolForOddsIds(
        oddsExport.equipment,
        { "1": row[24], "2": row[23], "3": row[22] },
        "equipmentId",
      ),
    };
  }

  return {
    type: 0,
    paymentType: 0,
    pageKind,
    singleCost,
    multiCost,
    discountCost,
    ...(tenTimesPerAccountCost ? { tenTimesPerAccountCost } : {}),
    ...(onceTicketItemId ? { onceTicketItemId } : {}),
    ...(tenTicketItemId ? { tenTicketItemId } : {}),
    wildcardTicketAvailable: parseOptionalBoolean(row[20]),
    rarityOddsId,
    guaranteeRarity,
    rankRates,
    movieName: String(row[17] || "normal"),
    guaranteeMovieName: String(row[18] || "normal_guarantee"),
    toUseOddsUpAsTrialReading: parseOptionalBoolean(row[19]),
    canBeStartDashExchange: parseOptionalBoolean(row[21]),
    startDate,
    endDate,
    name,
    pool: buildPoolForOddsIds(
      oddsExport.character,
      { "1": row[16], "2": row[15], "3": row[14] },
      "characterId",
    ),
  };
}

function buildGachaFromOdds(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const oddsExport = options.oddsExport || buildOddsExport({
    root,
    store: options.store,
  });
  const cdnGacha = JSON.parse(
    fs.readFileSync(path.join(root, "assets", "cdndata", "gacha.json"), "utf8"),
  );

  const output = {};
  for (const [gachaId, rowGroup] of Object.entries(cdnGacha)) {
    const row = firstRow(rowGroup);
    if (!row) {
      continue;
    }
    output[gachaId] = buildBannerFromRow(gachaId, row, oddsExport);
  }
  return output;
}

function itemMap(items = []) {
  return new Map(items.map((item) => [String(item.id), item]));
}

function valuesDiffer(oldItem, newItem) {
  return (
    oldItem.rank !== newItem.rank ||
    oldItem.odds !== newItem.odds ||
    oldItem.isRateUp !== newItem.isRateUp ||
    oldItem.isLimited !== newItem.isLimited ||
    oldItem.isExchangeable !== newItem.isExchangeable ||
    oldItem.trialReadingForced !== newItem.trialReadingForced ||
    oldItem.rarity !== newItem.rarity
  );
}

function diffPool(oldItems = [], newItems = []) {
  const oldMap = itemMap(oldItems);
  const newMap = itemMap(newItems);
  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, newItem] of newMap) {
    if (!oldMap.has(id)) {
      added.push(Number(id));
      continue;
    }
    const oldItem = oldMap.get(id);
    if (valuesDiffer(oldItem, newItem)) {
      changed.push({
        id: Number(id),
        old: oldItem,
        new: newItem,
      });
    }
  }

  for (const id of oldMap.keys()) {
    if (!newMap.has(id)) {
      removed.push(Number(id));
    }
  }

  added.sort((a, b) => a - b);
  removed.sort((a, b) => a - b);
  changed.sort((a, b) => a.id - b.id);

  return {
    count: {
      old: oldItems.length,
      new: newItems.length,
    },
    added,
    removed,
    changed,
  };
}

function diffMeta(oldBanner, newBanner) {
  const keys = new Set([...Object.keys(oldBanner || {}), ...Object.keys(newBanner || {})]);
  keys.delete("pool");
  const changed = {};
  for (const key of [...keys].sort()) {
    const oldValue = oldBanner ? oldBanner[key] : undefined;
    const newValue = newBanner ? newBanner[key] : undefined;
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changed[key] = { old: oldValue, new: newValue };
    }
  }
  return changed;
}

function hasPoolDiff(poolDiff) {
  return (
    poolDiff.count.old !== poolDiff.count.new ||
    poolDiff.added.length > 0 ||
    poolDiff.removed.length > 0 ||
    poolDiff.changed.length > 0
  );
}

function diffGacha(oldGacha, newGacha) {
  const oldIds = new Set(Object.keys(oldGacha || {}));
  const newIds = new Set(Object.keys(newGacha || {}));
  const allIds = [...new Set([...oldIds, ...newIds])].sort((a, b) => Number(a) - Number(b));
  const banners = {};
  const summary = {
    oldBanners: oldIds.size,
    newBanners: newIds.size,
    compared: allIds.length,
    addedBanners: 0,
    removedBanners: 0,
    changedBanners: 0,
    metaChangedBanners: 0,
    poolChangedBanners: 0,
    addedItems: 0,
    removedItems: 0,
    changedItems: 0,
  };

  for (const gachaId of allIds) {
    const oldBanner = oldGacha ? oldGacha[gachaId] : undefined;
    const newBanner = newGacha ? newGacha[gachaId] : undefined;
    if (!oldBanner) {
      summary.addedBanners += 1;
      banners[gachaId] = { status: "added" };
      continue;
    }
    if (!newBanner) {
      summary.removedBanners += 1;
      banners[gachaId] = { status: "removed" };
      continue;
    }

    const meta = diffMeta(oldBanner, newBanner);
    const poolKeys = [...new Set([
      ...Object.keys(oldBanner.pool || {}),
      ...Object.keys(newBanner.pool || {}),
    ])].sort();
    const pool = {};
    let poolChanged = false;
    for (const key of poolKeys) {
      const poolDiff = diffPool(oldBanner.pool?.[key] || [], newBanner.pool?.[key] || []);
      if (hasPoolDiff(poolDiff)) {
        pool[key] = poolDiff;
        poolChanged = true;
        summary.addedItems += poolDiff.added.length;
        summary.removedItems += poolDiff.removed.length;
        summary.changedItems += poolDiff.changed.length;
      }
    }

    if (Object.keys(meta).length || poolChanged) {
      summary.changedBanners += 1;
      if (Object.keys(meta).length) summary.metaChangedBanners += 1;
      if (poolChanged) summary.poolChangedBanners += 1;
      banners[gachaId] = {
        stringId: newBanner.name,
        meta,
        pool,
      };
    }
  }

  return { summary, banners };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--root") {
      options.root = argv[++i];
    } else if (arg === "--store") {
      options.store = argv[++i];
    } else if (arg === "--out") {
      options.out = argv[++i];
    } else if (arg === "--old-out") {
      options.oldOut = argv[++i];
    } else if (arg === "--diff-out") {
      options.diffOut = argv[++i];
    } else if (arg === "--no-write") {
      options.noWrite = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node tools/rebuild_gacha_from_odds.cjs [options]

Options:
  --root <repo>       Repository root. Defaults to cwd.
  --store <upload>    WorldFlipper production/upload store. Auto-detected by default.
  --out <json>        gacha output path. Defaults to ${DEFAULT_GACHA_PATH}.
  --old-out <json>    Old gacha snapshot path. Defaults to ${DEFAULT_OLD_SNAPSHOT}.
  --diff-out <json>   Difference report path. Defaults to ${DEFAULT_DIFF_PATH}.
  --no-write          Build and diff only; do not replace gacha output.`);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const root = path.resolve(options.root || process.cwd());
  const outputPath = path.resolve(root, options.out || DEFAULT_GACHA_PATH);
  const oldSnapshotPath = path.resolve(root, options.oldOut || DEFAULT_OLD_SNAPSHOT);
  const diffPath = path.resolve(root, options.diffOut || DEFAULT_DIFF_PATH);

  const oldGacha = fs.existsSync(outputPath)
    ? JSON.parse(fs.readFileSync(outputPath, "utf8"))
    : {};
  const newGacha = buildGachaFromOdds({ root, store: options.store });
  const diff = diffGacha(oldGacha, newGacha);

  writeJson(oldSnapshotPath, oldGacha);
  writeJson(diffPath, diff);
  if (!options.noWrite) {
    writeJson(outputPath, newGacha);
  }

  const summary = diff.summary;
  console.log(`${options.noWrite ? "built" : "wrote"} ${outputPath}`);
  console.log(`old snapshot: ${oldSnapshotPath}`);
  console.log(`diff report: ${diffPath}`);
  console.log(
    `banners old=${summary.oldBanners} new=${summary.newBanners} changed=${summary.changedBanners} ` +
      `added=${summary.addedBanners} removed=${summary.removedBanners}`,
  );
  console.log(
    `pool changes: banners=${summary.poolChangedBanners} ` +
      `items added=${summary.addedItems} removed=${summary.removedItems} changed=${summary.changedItems}`,
  );
}

module.exports = {
  buildBannerFromRow,
  buildGachaFromOdds,
  buildRankRates,
  diffGacha,
  diffPool,
  normalizePoolEntries,
  normalizeWeightsToThousand,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
