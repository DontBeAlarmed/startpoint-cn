// validate.cjs — measure the faithful predictor against the real-client ground truth.
//
// assets/verified_seeds.json holds (seed -> ball rarity) the REAL client computed,
// captured from actual C3032 reports via seed-validator.moveToVerified. This checks
// world.cjs (client-faithful gated simulate) against it.
//
// Usage:  node validate.cjs [assetsDir]
const fs = require("fs"), path = require("path");
const w = require("./world.cjs");

const ASSETS = process.argv[2] || path.join(__dirname, "..", "..", "assets");
const V = JSON.parse(fs.readFileSync(path.join(ASSETS, "verified_seeds.json"), "utf-8"));

let ok = 0, total = 0, byMovie = {};
for (const [movie, seeds] of Object.entries(V)) {
  byMovie[movie] = { ok: 0, n: 0 };
  for (const [s, r] of Object.entries(seeds)) {
    const hit = w.simulate(Number(s), movie) === Number(r);
    total++; byMovie[movie].n++;
    if (hit) { ok++; byMovie[movie].ok++; }
  }
}
console.log(`faithful predictor vs real-client truth: ${ok}/${total} (${(ok / total * 100).toFixed(2)}%)`);
for (const [m, x] of Object.entries(byMovie)) console.log(`  ${m}: ${x.ok}/${x.n} (${(x.ok / x.n * 100).toFixed(1)}%)`);
