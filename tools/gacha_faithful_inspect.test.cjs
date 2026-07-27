const assert = require("node:assert/strict")

const world = require("./gacha-faithful/world.cjs")

const MOVIES = ["normal", "normal_guarantee", "fes", "fes_guarantee"]

for (const movieId of MOVIES) {
    for (let seed = 1; seed <= 250; seed += 1) {
        const expected = world.initField(seed, movieId)
        const actual = world.precalculate(seed, movieId)
        assert.equal(actual.initialRarity, expected.ball.rarity, `${movieId} seed ${seed} initial rarity`)
        assert.equal(actual.moviePlayable, expected.moviePlayable, `${movieId} seed ${seed} movie playable`)
        assert.equal(actual.playProbability, expected.playProbability, `${movieId} seed ${seed} play probability`)
        if (!actual.moviePlayable) {
            assert.equal(actual.finalRarity, world.simulate(seed, movieId))
        }
    }
}

assert.deepStrictEqual(world.inspect(2, "normal"), {
    seed: 2,
    movieId: "normal",
    initialRarity: 0,
    finalRarity: 0,
    moviePlayable: false,
    playProbability: 0.2172699198126793,
    frameCount: 0,
    pinContactCount: 0,
    amuletContactCount: 0,
    rarityUpgradeCount: 0,
    finished: true,
})

assert.deepStrictEqual(world.inspect(1, "normal"), {
    seed: 1,
    movieId: "normal",
    initialRarity: 0,
    finalRarity: 1,
    moviePlayable: true,
    playProbability: 0.9888610874768347,
    frameCount: 203,
    pinContactCount: 4,
    amuletContactCount: 2,
    rarityUpgradeCount: 1,
    finished: true,
})

console.log("gacha faithful inspect tests passed")
