"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")

const characterSource = fs.readFileSync(
    require.resolve("../src/routes/api/character.ts"),
    "utf8",
)
const tutorialSource = fs.readFileSync(
    require.resolve("../src/routes/api/tutorial.ts"),
    "utf8",
)

function routeSegment(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker)
    assert.notEqual(start, -1, `missing route marker: ${startMarker}`)
    const end = source.indexOf(endMarker, start + startMarker.length)
    assert.notEqual(end, -1, `missing route end marker: ${endMarker}`)
    return source.slice(start, end)
}

test("character set_protection publishes through the common character projector", () => {
    const segment = routeSegment(
        characterSource,
        'fastify.post("/set_protection"',
        'fastify.post("/set_illustration_settings"',
    )

    assert.match(segment, /mergeCommonResponseFragments\(\[/)
    assert.match(segment, /projectCharacterPatch\(/)
})

test("tutorial first-award responses publish common fields through the shared projector", () => {
    const gachaSegment = routeSegment(
        tutorialSource,
        "const randomCharacterIndex = randomInt(0, TUTORIAL_GACHA_CHARACTER_IDS.length)",
        "if (effectiveNextStep === TUTORIAL_PRESENT_EFFECTIVE_STEP) {",
    )
    const presentSegment = routeSegment(
        tutorialSource,
        "const newVMoney = currentPlayer.freeVmoney + 1500",
        "const isTutorialEnd = effectiveNextStep === TUTORIAL_END_EFFECTIVE_STEP",
    )

    assert.match(gachaSegment, /mergeCommonResponseFragments\(\[/)
    assert.match(gachaSegment, /projectCharacterPatch\(/)
    assert.match(presentSegment, /mergeCommonResponseFragments\(\[/)
    assert.match(presentSegment, /projectCharacterPatch\(/)
    assert.match(gachaSegment, /["']gacha["']:/)
    assert.match(presentSegment, /["']encyclopedia_info["']:/)
})
