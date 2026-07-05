# WF offline mod tool usage

This tool edits the phone package runtime data under:

`WorldFlipper/dummy/download/production/upload`

It does not edit the extracted `assets` reference folder.

## Quick commands

Print ability columns:

```bat
mod-tools\wf-mod.bat schema
```

List one character's ability rows:

```bat
mod-tools\wf-mod.bat list --character 111002
```

Export one character's ability rows to CSV:

```bat
mod-tools\wf-mod.bat export --character 111002 --out edit\111002_ability.csv
```

After editing the CSV, preview the import:

```bat
mod-tools\wf-mod.bat import --edited edit\111002_ability.csv --dry-run
```

Write the edited CSV back:

```bat
mod-tools\wf-mod.bat import --edited edit\111002_ability.csv
```

Preview a recipe without writing:

```bat
mod-tools\wf-mod.bat apply --recipe mod-tools\examples\scale_pirates_girl_skill.recipe.json --dry-run
```

Apply a recipe and create a backup automatically:

```bat
mod-tools\wf-mod.bat apply --recipe mod-tools\examples\scale_pirates_girl_skill.recipe.json
```

## Recipe operations

Remove all main-position-only restrictions:

```json
{
  "operations": [
    { "op": "remove_main_position" }
  ]
}
```

Scale a character's common skill strength fields:

```json
{
  "operations": [
    {
      "op": "scale",
      "match": { "character": "111002" },
      "fields": "skill_strength",
      "factor": 1.5,
      "rounding": "int"
    }
  ]
}
```

Copy ability slots from one character to another while keeping the target
`string_id`:

```json
{
  "operations": [
    {
      "op": "copy_ability",
      "from_character": "111002",
      "to_character": "111003",
      "slots": [2, 3],
      "preserve_fields": ["string_id"]
    }
  ]
}
```

Set one field directly:

```json
{
  "operations": [
    {
      "op": "set",
      "match": { "ability": "1110022", "line": 2 },
      "field": "trigger.values.instant_content.values.strength.power1",
      "value": "90000"
    }
  ]
}
```

## Field aliases

`skill_strength` edits these common multiplier columns:

- `trigger.values.instant_content.values.strength.power1`
- `trigger.values.instant_content.values.strength2.power1`
- `trigger.values.instant_content.values.strength3.power1`
- `trigger.values.during_content.values.strength.power1`
- `trigger.values.during_content.values.strength2.power1`
- `trigger.values.opening.values.strength.power1`

Other aliases:

- `instant_strength`
- `during_strength`
- `duration_frames`
- `counts`
- `thresholds`

Use `schema` when you need an exact column name.
