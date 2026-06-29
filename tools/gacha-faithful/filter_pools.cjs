// filter_pools.cjs — make the gacha seed pools C3032-safe.
//
// Keeps a seed in  gacha_movie_seeds_<movie>.json[seedKey]["0"]  ONLY IF the
// bit-exact faithful predictor (world.cjs) computes the matching rarity, i.e.
//   world.cjs.simulate(seed, movie) === (3 - Number(seedKey))
// seedKey "1"=★5 / "2"=★4 / "3"=★3  (matches gacha.ts seedKey = 6 - rarity).
//
// world.cjs is gated exactly like the client's BallMovie.precalculateFieldResult:
// it only runs the physics loop when moviePlayable, else returns initBallRarity.
//
// The pre-filter originals are backed up to assets/_pool_backup_prefilter/.
// Re-running is idempotent (already-filtered pools stay the same).
//
// Usage:  node filter_pools.cjs [assetsDir]
//   default assetsDir = <repo>/assets
const fs = require("fs"), path = require("path");
const w = require("./world.cjs");

const ASSETS = process.argv[2] || path.join(__dirname, "..", "..", "assets");
const MOVIES = ["normal", "normal_guarantee", "fes", "fes_guarantee"];
const BACKUP = path.join(ASSETS, "_pool_backup_prefilter");
if (!fs.existsSync(BACKUP)) fs.mkdirSync(BACKUP, { recursive: true });

const t0 = Date.now();
for (const movie of MOVIES) {
  const file = path.join(ASSETS, `gacha_movie_seeds_${movie}.json`);
  if (!fs.existsSync(file)) { console.log(`${movie}: no file, skip`); continue; }
  const bak = path.join(BACKUP, `gacha_movie_seeds_${movie}.json`);
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);          // preserve the pristine original once
  const pool = JSON.parse(fs.readFileSync(bak, "utf-8"));        // always filter from the original
  const out = {};
  for (const seedKey of Object.keys(pool)) {
    out[seedKey] = {};
    const target = 3 - Number(seedKey);
    for (const mt of Object.keys(pool[seedKey])) {
      const src = pool[seedKey][mt];
      const kept = src.filter((s) => w.simulate(s, movie) === target);
      out[seedKey][mt] = kept;
      if (src.length) console.log(`  ${movie}[${seedKey}/${mt}] ★${target + 3}: ${src.length} -> ${kept.length} kept`);
    }
  }
  fs.writeFileSync(file, JSON.stringify(out), "utf-8");
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s. pre-filter backup: ${BACKUP}`);
