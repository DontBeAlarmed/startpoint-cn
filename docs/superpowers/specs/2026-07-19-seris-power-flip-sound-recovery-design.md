# Seris Power Flip Sound Recovery Design

## Problem

The Dragon King package contains six custom Power Flip timelines. Five timelines reference sound paths that do not exist in the CN client bundles or downloaded asset roots, so battle preload emits `FileNotFound` and shows the insufficient-data dialog. The package's 199 declared client payloads are otherwise present on device.

## Design

Keep the Power Flip visuals and actions unchanged. Correct only the timeline sound references so every custom PF uses Dragon King's new packaged sound effects rather than inherited knight/ranged sounds:

- Human Lv1-Lv3: `sound_effect/unique/se_seris_water_rise`
- Dragon Lv1-Lv3: `sound_effect/unique/se_seris_dragon_breath`

The authoring generator remains the source of truth and regenerates all six timeline containers. A regression test decodes the generated AMF3 timelines and asserts the exact six-path contract. The corrected candidate is then rebuilt through the whole-character pipeline, checked with preflight, published as a new resource version, downloaded by the existing client, and accepted only after an actual battle starts without `FileNotFound` events.

## Constraints

- Do not edit EntityList CSVs: both corrected sounds are already declared payloads in the whole-character package.
- Do not clear app data, uninstall the client, or alter player saves.
- Do not change PF damage, visual effects, action bindings, or unrelated Dragon King assets.
- Preserve all unrelated dirty-worktree files and do not commit user WIP.
