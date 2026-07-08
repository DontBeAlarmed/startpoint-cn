const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

// ── Constants ──────────────────────────────────────────────────
const SALT = "K6R9T9Hz22OpeIGEWB0ui6c6PYFQnJGy";

// Archive subdirectories to scan (under CDN_DIR)
const ARCHIVE_DIRS = [
  "archive-common-full",
  "archive-common-diff",
  "archive-medium-full",
  "archive-medium-diff",
  "archive-android-full",
  "archive-android-diff",
];

// ── Paths ──────────────────────────────────────────────────────
function getPaths() {
  const root = path.resolve(path.join(__dirname, ".."));
  return {
    root,
    cdnDir: path.join(root, ".cdn", "cn"),
    cacheDir: path.join(root, ".cdn"),
    outputDir: path.join(root, "tmp", "gacha_odds"),
    indexFile: path.join(root, ".cdn", "zip_index.json"),
    gachaJsonPath: path.join(root, "assets", "cdndata", "gacha.json"),
  };
}

// ── Hashing ────────────────────────────────────────────────────
function hashOddsPath(oddsId) {
  const normalized = `master/gacha_odds/${oddsId}.orderedmap`;
  const digest = crypto.createHash("sha1").update(normalized + SALT).digest("hex");
  return {
    logicalPath: normalized,
    relativePath: `${digest.slice(0, 2)}/${digest.slice(2)}`,
  };
}

// ── Helper: async exec ─────────────────────────────────────────
function execAsync(command, options) {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

// ── Phase 1: Collect odds IDs from gacha.json ──────────────────
function collectOddsIds(gachaJsonPath) {
  const gachaRows = JSON.parse(fs.readFileSync(gachaJsonPath, "utf8"));
  const oddsIds = new Set();

  function cleanStr(value) {
    if (value == null) return null;
    const text = String(value).trim();
    return text && text !== "(None)" ? text : null;
  }

  for (const rowGroup of Object.values(gachaRows)) {
    const row = Array.isArray(rowGroup)
      ? Array.isArray(rowGroup[0])
        ? rowGroup[0]
        : rowGroup
      : null;
    if (!row) continue;

    // Index 11: rarity odds
    const rarity = cleanStr(row[11]);
    if (rarity) oddsIds.add(rarity);

    const prizeKind = String(row[13] || "");

    if (prizeKind === "0") {
      // Character odds: indices 14 (rarity 3), 15 (rarity 4), 16 (rarity 5)
      for (const idx of [14, 15, 16]) {
        const id = cleanStr(row[idx]);
        if (id) oddsIds.add(id);
      }
    } else if (prizeKind === "1") {
      // Equipment odds: indices 22 (rarity 3), 23 (rarity 4), 24 (rarity 5)
      for (const idx of [22, 23, 24]) {
        const id = cleanStr(row[idx]);
        if (id) oddsIds.add(id);
      }
    }
  }

  return [...oddsIds].sort();
}

// ── Phase 1: Build zip index ───────────────────────────────────

/** Parse `unzip -l` output, return array of file paths inside the archive */
function parseZipListing(stdout) {
  const entries = [];
  const lines = stdout.split("\n");
  for (const line of lines) {
    // File entries format: "  NNNNN  MM-DD-YYYY HH:MM   path/to/file"
    const match = line.match(/^\s+\d+\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s{2}(.+)$/);
    if (match) {
      entries.push(match[1].trim());
    }
  }
  return entries;
}

/** Scan all CDN archives and build a path→archive mapping.
 *  Returns { index: Map, archiveCount: number } */
async function buildZipIndex(cdnDir) {
  // Find all zip files across archive directories
  const archives = [];
  const cdnRoot = cdnDir;

  for (const dirName of ARCHIVE_DIRS) {
    const dirPath = path.join(cdnRoot, dirName);
    if (!fs.existsSync(dirPath)) {
      console.warn(`  [WARN] directory not found: ${dirPath}`);
      continue;
    }
    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      if (entry.endsWith(".zip")) {
        archives.push({
          archiveDir: dirName,
          zipName: entry,
          fullPath: path.join(dirPath, entry),
          archiveRef: `${dirName}/${entry}`,
        });
      }
    }
  }

  const archiveCount = archives.length;
  console.log(`  Found ${archiveCount} zip archives across ${ARCHIVE_DIRS.length} directories`);
  console.log("  Indexing (this takes ~5 min)...");

  const index = new Map();
  const CONCURRENCY = 8;
  const startTime = Date.now();

  for (let i = 0; i < archives.length; i += CONCURRENCY) {
    const batch = archives.slice(i, i + CONCURRENCY);

    // Run unzip -l for all archives in this batch concurrently
    const batchResults = await Promise.allSettled(
      batch.map(async (archive) => {
        const stdout = await execAsync(`unzip -l "${archive.fullPath}"`, {
          timeout: 30000,
          maxBuffer: 20 * 1024 * 1024,
        });
        return { archive, entries: parseZipListing(stdout) };
      }),
    );

    // Process results
    for (const result of batchResults) {
      if (result.status === "rejected") {
        console.warn(`\n  [WARN] failed to list: ${result.reason.message}`);
        continue;
      }
      const { archive, entries } = result.value;
      for (const filePath of entries) {
        // First archive wins (full archives take priority over diffs)
        if (!index.has(filePath)) {
          index.set(filePath, archive.archiveRef);
        }
      }
    }

    const done = Math.min(i + CONCURRENCY, archives.length);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(`\r  ${done}/${archives.length} archives, ${index.size} entries, ${elapsed}s elapsed`);
  }

  console.log(""); // newline after progress
  return { index, archiveCount };
}

// ── Phase 2: Extract odds files ────────────────────────────────

async function extractOdds(cdnDir, index, outputDir, gachaJsonPath) {
  const oddsIds = collectOddsIds(gachaJsonPath);
  console.log(`  Found ${oddsIds.length} unique odds IDs from gacha.json`);

  let extracted = 0;
  let missing = 0;
  const CONCURRENCY = 8;
  const startTime = Date.now();

  // Pre-compute hash paths and classify
  const resolved = oddsIds.map((oddsId) => {
    const hashed = hashOddsPath(oddsId);
    const fullPath = `production/upload/${hashed.relativePath}`;
    const archiveRef = index.get(fullPath);
    return { oddsId, fullPath, relPath: hashed.relativePath, archiveRef };
  });

  // Log not-found items upfront and build work list
  const workItems = [];
  for (const item of resolved) {
    if (!item.archiveRef) {
      console.log(`  [MISSING] ${item.oddsId} → ${item.relPath} (not in any archive)`);
      missing++;
    } else {
      workItems.push(item);
    }
  }

  if (workItems.length === 0) {
    console.log("  No odds files to extract (all missing from archives).");
    return { extracted: 0, missing };
  }

  console.log(`  Extracting ${workItems.length} odds files from CDN archives...`);

  // Process in parallel batches
  for (let i = 0; i < workItems.length; i += CONCURRENCY) {
    const batch = workItems.slice(i, i + CONCURRENCY);

    const batchResults = await Promise.allSettled(
      batch.map(async ({ oddsId, fullPath, relPath, archiveRef }) => {
        const archivePath = path.join(cdnDir, archiveRef);
        const outputFilePath = path.join(outputDir, relPath);

        // Extract single file from zip to stdout as buffer
        const data = await execAsync(`unzip -p "${archivePath}" "${fullPath}"`, {
          encoding: "buffer",
          timeout: 10000,
          maxBuffer: 10 * 1024 * 1024,
        });

        fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
        fs.writeFileSync(outputFilePath, data);
        return { oddsId, relPath, archiveRef };
      }),
    );

    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      const item = batch[j];
      const idx = i + j + 1;
      if (result.status === "rejected") {
        console.log(`  [${missing + idx}/${oddsIds.length}] ${item.oddsId} → ❌ extract failed: ${result.reason.message}`);
        // Count as missing; will be adjusted in final tally
      } else {
        const { oddsId, relPath, archiveRef } = result.value;
        console.log(`  [${missing + idx}/${oddsIds.length}] ${oddsId} → ${relPath} → ${archiveRef} ✓`);
        extracted++;
      }
    }
  }

  // Count extraction failures
  const extractionFailures = workItems.length - extracted;
  missing += extractionFailures;

  console.log(`  Extracted: ${extracted}/${oddsIds.length}, Missing: ${missing}`);
  return { extracted, missing };
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const { cdnDir, cacheDir, outputDir, indexFile, gachaJsonPath } = getPaths();

  const doBuildIndex = args.includes("--build-index");
  const doExtract = args.includes("--extract");
  const doAll = !doBuildIndex && !doExtract;

  // Validate inputs exist
  if (!fs.existsSync(gachaJsonPath)) {
    console.error(`gacha.json not found: ${gachaJsonPath}`);
    process.exit(1);
  }

  // ── Phase 1: Build index ──
  if (doAll || doBuildIndex) {
    console.log("═══ Phase 1: Build zip index ═══");
    console.log(`CDN directory: ${cdnDir}`);

    if (!fs.existsSync(cdnDir)) {
      console.error(`CDN directory not found: ${cdnDir}`);
      console.error("Use --cdn-dir <path> to specify a custom location.");
      process.exit(1);
    }

    const { index, archiveCount } = await buildZipIndex(cdnDir);

    // Save index as JSON (Map → Object for serialization)
    const indexObj = Object.fromEntries(index);
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(indexFile, JSON.stringify(indexObj), "utf8");

    const sizeMB = (Buffer.byteLength(JSON.stringify(indexObj)) / 1024 / 1024).toFixed(1);
    console.log(
      `Index: ${archiveCount} archives, ${index.size.toLocaleString()} entries saved to ${indexFile} (${sizeMB}MB)`,
    );
  }

  // ── Phase 2: Extract odds ──
  if (doAll || doExtract) {
    console.log("\n═══ Phase 2: Extract odds files ═══");

    if (!fs.existsSync(indexFile)) {
      console.error(`Index file not found: ${indexFile}`);
      console.error("Run with --build-index first.");
      process.exit(1);
    }

    const index = new Map(Object.entries(JSON.parse(fs.readFileSync(indexFile, "utf8"))));
    const { extracted, missing } = await extractOdds(cdnDir, index, outputDir, gachaJsonPath);

    // Count output files
    let fileCount = 0;
    let totalSize = 0;
    if (fs.existsSync(outputDir)) {
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            fileCount++;
            totalSize += fs.statSync(full).size;
          }
        }
      };
      walk(outputDir);
    }

    console.log(
      `Output: ${outputDir}/ (${fileCount} files, ${(totalSize / 1024 / 1024).toFixed(1)}MB)`,
    );
  }
}

// ── Entry point ─────────────────────────────────────────────────
if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
