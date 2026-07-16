# Seris combat P-code fixture contract

The committed tests lock the World Flipper CN `1.4.54` baseline SWF by SHA-256
and six fully-qualified existing method bodies. The corresponding FFDec 26.2.1
P-code export is generated locally under:

`work/seris-combat/evidence/fresh-baseline-six/scripts`

Generated SWFs and P-code exports are intentionally not committed. Tests that
need the export skip when it is absent; tests backed by the locked SWF still
verify method-body index and bytecode SHA-256 directly.

The NormalAttackCalculator package is
`pinball.online.battle.impact.attack`, not a scene-battle package.
