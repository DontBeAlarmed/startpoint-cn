# CN gacha odds rebuild

## Symptom

Some CN banners had missing, stale, or expanded prize pools whose members and
weights did not match the official odds data.

## Root cause

This is not CDN transfer corruption. Two deterministic rebuild defects caused
the mismatch:

1. The archive index used the first ZIP containing a path. With full and
   incremental archives present, that could select an older copy of the same
   odds file.
2. The rebuild script synthesized element-revival and missing holiday pools by
   accumulating character-table entries. Those inferred pools were not
   authoritative CN odds and could add characters absent from the official
   banner.

The archive `gacha-odds-fix-2026-07-14.zip` is directionally correct. Its data
replacement is appropriate only when paired with a reproducible extractor that
selects the newest archive and a builder that does not regenerate synthetic
pools afterward.

## Fix

- Parse ZIP listings independently of the local `unzip` date format.
- Compare semantic versions in archive names and select the newest archive for
  duplicate paths.
- Build every pool directly from its referenced official odds file.
- Remove element accumulation and holiday synthetic fallbacks.
- Rebuild `assets/gacha.json` from all 935 available official odds files.

The existing gacha rule, execution-plan, and draw-weight regressions validate
banner eligibility and weighted draws against the rebuilt data.
