# CN early event currency fix

## Symptom

Some early advent score rewards granted an item ID that did not match the
currency accepted by the active CN event shop. The reward appeared to be
missing even though the score reward itself completed normally.

## Root cause

This is not a CDN download or transport-corruption problem. The server combined
score reward rows and event shop rows from different CN master-data generations.
Several event currencies reuse the same display name while their numeric IDs
change between reruns. A static score-reward ID can therefore point at an older
generation than the shop active at the server's virtual date.

The archive `CN早期降临活动代币相关.zip` correctly identifies the affected
reward rows, but replacing IDs only in `score_reward.json` is not sufficient for
servers that move the virtual date across original runs and reruns.

## Fix

- Correct the known mixed-generation rows in `assets/score_reward.json`.
- Build currency families from `event_item_shop.json` using the shared names in
  `item_lookup.json`.
- At reward time, select the family member whose shop availability contains the
  player's virtual server date.
- Leave unrelated item IDs unchanged.

This preserves old-event behavior while also supporting later reruns. The
focused regression covers the original ID, the `999800` generation, the later
`70002` generation, dates with no matching shop, and unrelated items.
