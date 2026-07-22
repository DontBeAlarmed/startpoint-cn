import type { CharacterConversionOutput } from "./character"

function assertReadonlyCharacterOutput(output: CharacterConversionOutput): void {
    // @ts-expect-error Character table keys are readonly.
    output["character.json"]["1"] = { name: "", rarity: 1, element: 0, skill_count: 1 }
    // @ts-expect-error Character values are readonly.
    output["character.json"]["1"].rarity = 5
    // @ts-expect-error CDN table keys are readonly.
    output["cdndata/character.json"]["1"] = [[]]
    // @ts-expect-error CDN row collections are readonly.
    output["cdndata/character.json"]["1"].push([])
    // @ts-expect-error CDN rows are readonly.
    output["cdndata/character_text.json"]["1"][0].push("changed")
    // @ts-expect-error CDN cells cannot be replaced.
    output["cdndata/character_text.json"]["1"][0][0] = "changed"
}

void assertReadonlyCharacterOutput
