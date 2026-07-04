const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SALT = "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy";
const DEFAULT_OUTPUT = path.join("out", "gacha_odds_export.json");

function normalizeAssetPath(assetPath) {
  return assetPath.replace(/[\/\\]+/g, "/").replace(/^\//, "");
}

function hashAssetPath(assetPath) {
  const normalized = normalizeAssetPath(assetPath);
  const digest = crypto.createHash("sha1").update(normalized + SALT).digest("hex");
  return {
    logicalPath: normalized,
    relativePath: `${digest.slice(0, 2)}/${digest.slice(2)}`,
  };
}

function hashOddsPath(oddsId) {
  return hashAssetPath(`master/gacha_odds/${oddsId}.orderedmap`);
}

function findDefaultUploadStore(root = process.cwd()) {
  const direct = path.join(root, "WorldFlipper", "dummy", "download", "production", "upload");
  if (fs.existsSync(direct)) {
    return direct;
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(
      root,
      entry.name,
      "WorldFlipper",
      "dummy",
      "download",
      "production",
      "upload",
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function parseOrderedMapIndex(raw) {
  if (raw.length < 8) {
    throw new Error("orderedmap is too small");
  }
  const indexLength = raw.readUInt32LE(0);
  if (indexLength <= 0 || 4 + indexLength > raw.length) {
    throw new Error(`invalid orderedmap index length: ${indexLength}`);
  }

  const index = zlib.inflateSync(raw.subarray(4, 4 + indexLength));
  const count = index.readUInt32LE(0);
  const pairs = [];
  for (let i = 0; i < count; i += 1) {
    const offset = 4 + i * 8;
    pairs.push({
      keyEnd: index.readUInt32LE(offset),
      rowEnd: index.readUInt32LE(offset + 4),
    });
  }

  const keyBlob = index.subarray(4 + count * 8);
  const keys = [];
  let previousKeyEnd = 0;
  for (const pair of pairs) {
    keys.push(keyBlob.subarray(previousKeyEnd, pair.keyEnd).toString("utf8"));
    previousKeyEnd = pair.keyEnd;
  }

  return { indexLength, keys, pairs };
}

function readOrderedMapRawRowsFromBuffer(raw) {
  const { indexLength, keys, pairs } = parseOrderedMapIndex(raw);
  const blob = raw.subarray(4 + indexLength);
  const rows = [];
  let previousRowEnd = 0;
  for (const pair of pairs) {
    rows.push(blob.subarray(previousRowEnd, pair.rowEnd));
    previousRowEnd = pair.rowEnd;
  }
  return { keys, rows };
}

function readTextRowsFromOrderedMapBuffer(raw) {
  const ordered = readOrderedMapRawRowsFromBuffer(raw);
  return ordered.keys.map((key, index) => ({
    key,
    text: ordered.rows[index].length ? zlib.inflateSync(ordered.rows[index]).toString("utf8") : "",
  }));
}

function readNestedTextRows(filePath, expectedOuterKey) {
  const outer = readOrderedMapRawRowsFromBuffer(fs.readFileSync(filePath));
  if (outer.keys.length !== 1) {
    throw new Error(`${filePath} should contain exactly one outer key, got ${outer.keys.length}`);
  }
  const outerKey = outer.keys[0];
  if (expectedOuterKey && outerKey !== expectedOuterKey) {
    throw new Error(`${filePath} outer key mismatch: expected ${expectedOuterKey}, got ${outerKey}`);
  }
  return {
    outerKey,
    rows: readTextRowsFromOrderedMapBuffer(outer.rows[0]),
  };
}

function parseBoolean(value, fieldName, source) {
  const normalized = String(value).toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error(`invalid boolean for ${fieldName} in ${source}: ${value}`);
}

function parseIntField(value, fieldName, source) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid integer for ${fieldName} in ${source}: ${value}`);
  }
  return parsed;
}

function parseRarityRow(text, source) {
  const cells = text.split(",");
  if (cells.length !== 2) {
    throw new Error(`rarity odds row should have 2 columns in ${source}: ${text}`);
  }
  return {
    rarity: parseIntField(cells[0], "rarity", source),
    weight: parseIntField(cells[1], "weight", source),
  };
}

function parseCharacterRow(text, source) {
  const cells = text.split(",");
  if (cells.length !== 7) {
    throw new Error(`character odds row should have 7 columns in ${source}: ${text}`);
  }
  return {
    characterId: parseIntField(cells[0], "characterId", source),
    rarity: parseIntField(cells[1], "rarity", source),
    weight: parseIntField(cells[2], "weight", source),
    oddsUp: parseBoolean(cells[3], "oddsUp", source),
    isLimited: parseBoolean(cells[4], "isLimited", source),
    isExchangeable: parseBoolean(cells[5], "isExchangeable", source),
    trialReadingForced: parseBoolean(cells[6], "trialReadingForced", source),
  };
}

function parseEquipmentRow(text, source) {
  const cells = text.split(",");
  if (cells.length !== 6) {
    throw new Error(`equipment odds row should have 6 columns in ${source}: ${text}`);
  }
  return {
    equipmentId: parseIntField(cells[0], "equipmentId", source),
    rarity: parseIntField(cells[1], "rarity", source),
    weight: parseIntField(cells[2], "weight", source),
    oddsUp: parseBoolean(cells[3], "oddsUp", source),
    isLimited: parseBoolean(cells[4], "isLimited", source),
    isExchangeable: parseBoolean(cells[5], "isExchangeable", source),
  };
}

function parseRowsForKind(kind, rows, oddsId) {
  return rows.map((row) => {
    const source = `${oddsId}[${row.key}]`;
    if (kind === "rarity") {
      return parseRarityRow(row.text, source);
    }
    if (kind === "character") {
      return parseCharacterRow(row.text, source);
    }
    if (kind === "equipment") {
      return parseEquipmentRow(row.text, source);
    }
    throw new Error(`unknown odds kind: ${kind}`);
  });
}

function readOddsFile(store, oddsId, kind) {
  const hashed = hashOddsPath(oddsId);
  const filePath = path.join(store, ...hashed.relativePath.split("/"));
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing odds file for ${oddsId}: ${hashed.relativePath}`);
  }

  const nested = readNestedTextRows(filePath, oddsId);
  return {
    id: oddsId,
    kind,
    logicalPath: hashed.logicalPath,
    relativePath: hashed.relativePath,
    filePath,
    entries: parseRowsForKind(kind, nested.rows, nested.outerKey),
  };
}

function cleanId(value) {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  if (!text || text === "(None)") {
    return null;
  }
  return text;
}

function addClean(target, value) {
  const id = cleanId(value);
  if (id) {
    target.add(id);
  }
}

function firstRow(rowGroup) {
  if (Array.isArray(rowGroup) && Array.isArray(rowGroup[0])) {
    return rowGroup[0];
  }
  if (Array.isArray(rowGroup)) {
    return rowGroup;
  }
  return null;
}

function collectOddsIds(gachaRows) {
  const out = {
    rarity: new Set(),
    character: new Set(),
    equipment: new Set(),
    banners: [],
  };

  for (const [gachaId, rowGroup] of Object.entries(gachaRows)) {
    const row = firstRow(rowGroup);
    if (!row) {
      continue;
    }
    addClean(out.rarity, row[11]);
    const prizeKind = row[13];
    const banner = {
      gachaId,
      stringId: row[0],
      title: row[1],
      prizeKind: Number.parseInt(prizeKind, 10),
      rarityOdds: cleanId(row[11]),
    };

    if (prizeKind === "0") {
      banner.characterOdds = {
        rarity3: cleanId(row[14]),
        rarity4: cleanId(row[15]),
        rarity5: cleanId(row[16]),
      };
      addClean(out.character, row[14]);
      addClean(out.character, row[15]);
      addClean(out.character, row[16]);
    } else if (prizeKind === "1") {
      banner.equipmentOdds = {
        rarity3: cleanId(row[22]),
        rarity4: cleanId(row[23]),
        rarity5: cleanId(row[24]),
      };
      addClean(out.equipment, row[22]);
      addClean(out.equipment, row[23]);
      addClean(out.equipment, row[24]);
    }
    out.banners.push(banner);
  }

  return out;
}

function readGroup(store, ids, kind, missing) {
  const out = {};
  for (const oddsId of [...ids].sort()) {
    try {
      out[oddsId] = readOddsFile(store, oddsId, kind);
    } catch (error) {
      const hashed = hashOddsPath(oddsId);
      missing.push({
        kind,
        id: oddsId,
        logicalPath: hashed.logicalPath,
        relativePath: hashed.relativePath,
        reason: error.message,
      });
    }
  }
  return out;
}

function loadGachaRows(root) {
  const gachaPath = path.join(root, "assets", "cdndata", "gacha.json");
  return {
    path: gachaPath,
    rows: JSON.parse(fs.readFileSync(gachaPath, "utf8")),
  };
}

function buildOddsExport(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const store = options.store || findDefaultUploadStore(root);
  if (!store) {
    throw new Error(`cannot find WorldFlipper production/upload under ${root}`);
  }

  const gacha = loadGachaRows(root);
  const ids = collectOddsIds(gacha.rows);
  const missing = [];
  const rarity = readGroup(store, ids.rarity, "rarity", missing);
  const character = readGroup(store, ids.character, "character", missing);
  const equipment = readGroup(store, ids.equipment, "equipment", missing);
  const characterBanners = ids.banners.filter((banner) => banner.prizeKind === 0).length;
  const equipmentBanners = ids.banners.filter((banner) => banner.prizeKind === 1).length;

  return {
    generatedAt: new Date().toISOString(),
    source: {
      root,
      uploadStore: path.resolve(store),
      gachaTable: gacha.path,
    },
    columns: {
      rarityOdds: 11,
      prizeKind: 13,
      characterOdds: { rarity3: 14, rarity4: 15, rarity5: 16 },
      equipmentOdds: { rarity3: 22, rarity4: 23, rarity5: 24 },
    },
    summary: {
      banners: ids.banners.length,
      characterBanners,
      equipmentBanners,
      oddsIds: {
        rarity: ids.rarity.size,
        character: ids.character.size,
        equipment: ids.equipment.size,
      },
      loaded: {
        rarity: Object.keys(rarity).length,
        character: Object.keys(character).length,
        equipment: Object.keys(equipment).length,
      },
      missing: missing.length,
    },
    missing,
    banners: ids.banners,
    rarity,
    character,
    equipment,
  };
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
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node tools/gacha_odds_export.cjs [--root <repo>] [--store <upload>] [--out <json>]

Exports CDN gacha_odds orderedmaps referenced by assets/cdndata/gacha.json.
Default output: ${DEFAULT_OUTPUT}`);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const root = path.resolve(options.root || process.cwd());
  const outPath = path.resolve(root, options.out || DEFAULT_OUTPUT);
  const exported = buildOddsExport({ root, store: options.store });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(exported, null, 2), "utf8");

  const summary = exported.summary;
  console.log(`wrote ${outPath}`);
  console.log(
    `banners=${summary.banners} character=${summary.characterBanners} equipment=${summary.equipmentBanners}`,
  );
  console.log(
    `odds loaded: rarity=${summary.loaded.rarity}/${summary.oddsIds.rarity}, ` +
      `character=${summary.loaded.character}/${summary.oddsIds.character}, ` +
      `equipment=${summary.loaded.equipment}/${summary.oddsIds.equipment}, missing=${summary.missing}`,
  );
}

module.exports = {
  buildOddsExport,
  collectOddsIds,
  findDefaultUploadStore,
  hashAssetPath,
  hashOddsPath,
  readNestedTextRows,
  readOddsFile,
  readOrderedMapRawRowsFromBuffer,
  readTextRowsFromOrderedMapBuffer,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
