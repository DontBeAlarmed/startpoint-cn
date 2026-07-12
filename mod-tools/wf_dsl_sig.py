#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""技能 ActionDsl 命令/枚举签名表(自动生成,勿手改生成段)。

来源:反编译 AS3(弹国服/scripts/pinball/battle/action/dsl/*,2026-07-12 提取):
  * ActionDslCommand.as / ActionDslEvent.as:每个命令的**位置参数签名**
    (全库 1024 个技能 DSL 实测:同名命令参数个数唯一,签名稳定)。
  * §const§/*.as:参数里出现的 haxe enum 构造(数据中序列化为 [标签, 参数...])。
树语法(ActionDslExpression):["Block",[表达式...]] | ["Command",[命令名,参数...]]
                            | ["Event",[事件名,参数...]]。
中文标注为人工整理:命令名/状态词条(AC*)已核对数据实例;参数标签只标注有把握的,
其余显示类型名。[{min,max}] 包装 = SLv1/满级两端值(技能等级线性插值)。
"""

# 命令签名:名称 -> 参数类型列表(序列化时 = ["Command",[名称,*参数]])
COMMANDS = {
 "AddCombo": [
  "Array"
 ],
 "AddFeverPoint": [
  "Array"
 ],
 "AddSkillPoint": [
  "int",
  "Array"
 ],
 "BindCoffinRevivalCountVariable": [
  "int",
  "Array",
  "Array",
  "Array",
  "Array",
  "Array",
  "int",
  "int",
  "Number"
 ],
 "BindCoffinRevivalCountVariableOf": [
  "int",
  "int",
  "int",
  "Number"
 ],
 "BindConditionAccumulationVariable": [
  "int",
  "int",
  "DeletionalConditionKind",
  "int",
  "Number"
 ],
 "CancelFlood": [],
 "CancelGravitationalField": [],
 "CancelShield": [],
 "ChangeBgm": [
  "String",
  "BgmFadeKind"
 ],
 "ChangeFieldAnimation": [
  "int",
  "String"
 ],
 "ChangeFieldAssets": [
  "int",
  "int",
  "int",
  "Option",
  "Option",
  "Option",
  "Option",
  "Option",
  "Option",
  "Option",
  "Option",
  "Option",
  "Option",
  "Option",
  "Option",
  "Option"
 ],
 "ConditionalsChangeSkillFlag": [
  "int",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsCoffinCountFilter": [
  "int",
  "int",
  "Array",
  "Array",
  "Array",
  "Array",
  "Array",
  "int",
  "int",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsCoffinCountSubject": [
  "int",
  "int",
  "int",
  "int",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsCombo": [
  "Number",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsConditionAccumulationNumber": [
  "DeletionalConditionKind",
  "int",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsConditionExist": [
  "int",
  "DeletionalConditionKind",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsFeverMode": [
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsHealthPointRatio": [
  "int",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsHealthPointRatioOf": [
  "int",
  "int",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsHitAreaHitCount": [
  "int",
  "int",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsMainOrUnison": [
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsMultiballNumber": [
  "Array",
  "Array",
  "int",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsNumCoffins": [
  "ActionDslExpression",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsNumExecutions2": [
  "Boolean",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsNumExecutions3": [
  "Boolean",
  "ActionDslExpression",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsNumExecutions4": [
  "Boolean",
  "ActionDslExpression",
  "ActionDslExpression",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsNumExecutions5": [
  "Boolean",
  "ActionDslExpression",
  "ActionDslExpression",
  "ActionDslExpression",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsNumExecutionsOddOrEven": [
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsProbability": [
  "ActionDslExpression"
 ],
 "ConditionalsRelativePositionVertical": [
  "int",
  "int",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsSkillPoint200Percent": [
  "Boolean",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConditionalsUnifyElement": [
  "int",
  "int",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "ConsumeUniqueCondition": [
  "int",
  "int",
  "Option"
 ],
 "CreateBarrier": [
  "int",
  "Array",
  "BarrierHitEffect"
 ],
 "CreateBombMultiball": [
  "int",
  "String",
  "MultiballReadyEffect",
  "Effect",
  "Effect",
  "String",
  "int",
  "Boolean"
 ],
 "CreateCollider": [
  "int",
  "String",
  "ColliderShape",
  "ColliderLifetime",
  "CoordSysSource",
  "int",
  "int",
  "Number",
  "Boolean",
  "Boolean"
 ],
 "CreateCondition": [
  "int",
  "Array",
  "Array",
  "ConditionHitEffect",
  "Boolean",
  "Boolean",
  "String",
  "HitCountCheckTargetKind",
  "Boolean",
  "int",
  "Array",
  "Boolean"
 ],
 "CreateFixedAttack": [
  "int",
  "Array",
  "FixedAttackHitEffect"
 ],
 "CreateFlood": [
  "int"
 ],
 "CreateGravitationalField": [
  "int",
  "Number",
  "int",
  "int",
  "int",
  "int",
  "int",
  "HAlign",
  "VAlign",
  "Boolean"
 ],
 "CreateHitArea": [
  "String",
  "int",
  "CoordSysSource",
  "int",
  "int",
  "Number",
  "Boolean",
  "Boolean",
  "Shape",
  "HAlign",
  "VAlign",
  "Formation",
  "ActionHitAreaLifetime",
  "MinHitInterval",
  "Option",
  "Boolean",
  "Boolean",
  "Option",
  "int",
  "ActionDslExpression",
  "int",
  "int",
  "ActionDslExpression",
  "int",
  "int",
  "HitAreaGuardMode"
 ],
 "CreateNormalAttack": [
  "int",
  "int",
  "Array",
  "Array",
  "int",
  "Array",
  "Array",
  "Boolean",
  "Boolean",
  "Boolean",
  "Boolean",
  "Boolean",
  "Array",
  "Array",
  "AttackHitEffect",
  "Boolean"
 ],
 "CreateNormalHeal": [
  "int",
  "Array",
  "Array",
  "Array",
  "HealHitEffect"
 ],
 "CreateOneWayWallGimmick": [
  "int",
  "String",
  "int",
  "int",
  "int",
  "int",
  "HAlign",
  "Boolean"
 ],
 "CreateOnlyHitAttack": [
  "int",
  "Array",
  "Array",
  "Boolean",
  "int",
  "AttackHitEffect"
 ],
 "CreatePointsDistanceDetector": [
  "int",
  "int",
  "Array",
  "Array",
  "int",
  "ActionDslExpression"
 ],
 "CreateRatioAttack": [
  "int",
  "int",
  "Array"
 ],
 "CreateRatioHeal": [
  "int",
  "int",
  "Array",
  "Array",
  "Array",
  "HealHitEffect"
 ],
 "CreateReferencePoint": [
  "int",
  "CoordSysSource",
  "int",
  "int",
  "Number",
  "Boolean",
  "Boolean",
  "Formation",
  "int",
  "int",
  "ActionDslExpression"
 ],
 "CreateReferencePointAtSpecifiedPosition": [
  "int",
  "int",
  "int",
  "int",
  "ActionDslExpression"
 ],
 "CreateShield": [
  "Number",
  "Number",
  "int",
  "int",
  "ShieldLifetime",
  "ShieldMovementKind",
  "ShieldDisplayKind",
  "Boolean"
 ],
 "CreateShockWaveAttack": [
  "String",
  "int",
  "CoordSysSource",
  "int",
  "int",
  "Number",
  "ShockWaveShape",
  "Effect",
  "LayerZDepth",
  "int",
  "int",
  "int",
  "ActionDslExpression",
  "HitAreaGuardMode"
 ],
 "CreateSummonsMultiball": [
  "int",
  "int",
  "Array",
  "MultiballReadyEffect",
  "Effect",
  "Effect",
  "int",
  "Boolean",
  "String",
  "int",
  "int",
  "ActionDslExpression",
  "Object"
 ],
 "CreateTargetAttack": [
  "int",
  "int",
  "int",
  "TargetAttackLifetime",
  "String"
 ],
 "CreateTornado": [
  "int",
  "int",
  "int",
  "Number",
  "int",
  "int",
  "String",
  "Boolean"
 ],
 "CreateWallDistanceDetector": [
  "int",
  "Array",
  "int",
  "ActionDslExpression"
 ],
 "CreateWindAttack": [
  "int",
  "Number",
  "int"
 ],
 "DecreaseCoffinCount": [
  "int",
  "int",
  "DecreaseCoffinCountHitEffect"
 ],
 "DeleteCondition": [
  "int",
  "DeletionalConditionKind",
  "int",
  "int",
  "String",
  "DeleteConditionSyncMode"
 ],
 "EliminateAllFunnel": [],
 "EliminateAlterEgo": [
  "EliminateAlterEgoTarget"
 ],
 "EliminateFunnel": [
  "SpawnFunnelKind"
 ],
 "EraseHitArea": [
  "int"
 ],
 "ExtendCondition": [
  "int",
  "DeletionalConditionKind",
  "int"
 ],
 "FadeOutBgm": [
  "Number"
 ],
 "FindAllSubjects": [
  "int",
  "int",
  "Array",
  "Array",
  "Array",
  "Array",
  "Array",
  "IfTargetNotFound",
  "ActionDslExpression"
 ],
 "FindMultiballSubjects": [
  "int",
  "int",
  "Boolean",
  "Array",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "FindNearSubjects": [
  "int",
  "int",
  "int",
  "IfTargetNotFound",
  "int",
  "ActionDslExpression"
 ],
 "HideCharacter": [
  "int",
  "int"
 ],
 "HideEffect": [
  "String"
 ],
 "HideEffectFromOwner": [
  "String"
 ],
 "IfThisCharacterIsBoss": [
  "int",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "IfThisCharacterIsLeader": [
  "int",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "IfThisCharacterIsSpecificBoss": [
  "int",
  "String",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "IfThisCharacterIsSpecificFunnel": [
  "int",
  "SpawnFunnelKind",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "MoveBall": [
  "int",
  "CoordSysSource",
  "Number",
  "int",
  "Number",
  "EndingSpeedKind",
  "Boolean"
 ],
 "MoveHitArea": [
  "int",
  "CoordSysSource",
  "Number",
  "Number",
  "TweenSource"
 ],
 "MultiballNumberVariable": [
  "int",
  "Boolean",
  "Array",
  "Array",
  "int",
  "Number"
 ],
 "NotifyPowerflipEnd": [
  "int"
 ],
 "ProbabilityWeight": [
  "Number"
 ],
 "RecoveryHitCountCheck": [
  "int",
  "HitCountCheckTargetKind",
  "int"
 ],
 "RemoveCollider": [
  "String"
 ],
 "RemoveColliderFromOwner": [
  "String"
 ],
 "RemoveEvent": [
  "String"
 ],
 "RemoveEventFromOwner": [
  "String"
 ],
 "RemoveMultiball": [
  "Boolean",
  "Array"
 ],
 "RemoveOneWayWallGimmick": [
  "String"
 ],
 "Revive": [
  "int",
  "DecreaseCoffinCountHitEffect"
 ],
 "RotateHitArea": [
  "int",
  "Number",
  "TweenSource"
 ],
 "SetHitAreaSomeHitsWithAnyTargetHandler": [
  "int",
  "int",
  "ActionDslExpression"
 ],
 "SetHitAreaSomeHitsWithSpecificTargetHandler": [
  "int",
  "int",
  "int",
  "ActionDslExpression"
 ],
 "SetHitAreaTerminateHandler": [
  "int",
  "ActionDslExpression"
 ],
 "SetPowerFilpSuppress": [
  "int"
 ],
 "ShakeCamera": [
  "int"
 ],
 "ShowEffect": [
  "String",
  "Effect",
  "int",
  "LayerZDepth",
  "EffectLifetime",
  "CoordSysSource",
  "int",
  "int",
  "Number",
  "Boolean",
  "Boolean",
  "Option"
 ],
 "SpawnAlterEgo": [
  "String",
  "SpawnAlterEgoPoint",
  "Boolean",
  "Boolean"
 ],
 "SpawnFunnel": [
  "SpawnFunnelKind",
  "int",
  "SpawnFunnelPoint",
  "Array"
 ],
 "StartBuffField": [
  "int",
  "String",
  "Array"
 ],
 "StartModifierField": [
  "int",
  "Array",
  "ModifierFieldCancelTriggerSourceKind"
 ],
 "StartPiercing": [
  "int",
  "int"
 ],
 "StopBall": [
  "int",
  "int",
  "EndingSpeedKind",
  "CoordSysSource",
  "Number"
 ],
 "StopBuffField": [],
 "StopModifierField": [],
 "StopPiercing": [
  "int"
 ],
 "SubtractFeverPoint": [
  "Array"
 ],
 "SubtractSkillPoint": [
  "int",
  "Array"
 ],
 "SuppressBallActivity": [
  "int",
  "Array"
 ],
 "SuppressSkill": [
  "int",
  "Array"
 ],
 "TargetMate": [
  "int",
  "Array",
  "Array",
  "Array",
  "Array",
  "Array"
 ],
 "Trace": [
  "String"
 ]
}

# 事件签名(["Event",[名称,*参数]])
EVENTS = {
 "ActivatedMultiballOfExecutorSelf": [
  "String",
  "int",
  "int",
  "ActionDslExpression"
 ],
 "CollisionOfBallAndEnemy": [
  "int",
  "int",
  "String",
  "int",
  "ActionDslExpression"
 ],
 "CollisionOfBallAndSpecificEnemy": [
  "int",
  "int",
  "int",
  "String",
  "int",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "CollisionOfSpecificBallAndSpecificEnemy": [
  "int",
  "int",
  "int",
  "int",
  "String",
  "int",
  "ActionDslExpression",
  "ActionDslExpression"
 ],
 "Repeat": [
  "int",
  "int",
  "String",
  "ActionDslExpression"
 ],
 "Wait": [
  "int",
  "String",
  "ActionDslExpression"
 ]
}

# 枚举构造签名:类名 -> {构造名: [参数类型...]}(数据中 = [构造名, *参数])
ENUMS = {
 "ActionConditionalKind": {
  "ChangeSkillFlag": [
   "Object"
  ],
  "ConditionExist": [
   "DeletionalConditionKind",
   "Object"
  ],
  "HpHigh": [
   "Number",
   "Object"
  ],
  "IsUnison": [
   "Object"
  ],
  "MultiballNumber": [
   "Array",
   "int",
   "Object"
  ],
  "None": []
 },
 "ActionHitAreaLifetime": {
  "RemainingFramesOfCurrentStateGroup": [],
  "SpecifyHitAreaLifetimeDirectly": [
   "int"
  ],
  "SpecifyHitAreaLifetimeSLv": [
   "Array"
  ]
 },
 "ActionTargetSubjectKind": {
  "All": [],
  "AllEnemies": [],
  "Normal": [
   "int"
  ]
 },
 "AdditionalConditionKind": {
  "ACAbilityDamage": [
   "Array",
   "Array",
   "Array"
  ],
  "ACAbilityDamageResistance": [
   "Array",
   "Array",
   "Array"
  ],
  "ACAdditionalDirectAttack": [
   "Array",
   "Array",
   "Array",
   "Array"
  ],
  "ACAdversity": [
   "Array",
   "Array",
   "Array",
   "Array"
  ],
  "ACAttackPoint": [
   "Array",
   "Array",
   "Array"
  ],
  "ACBipolar": [
   "Array",
   "Array",
   "Array",
   "int",
   "Array"
  ],
  "ACBuffRejection": [
   "Array"
  ],
  "ACComboBoost": [
   "Array",
   "Array"
  ],
  "ACComboRestriction": [
   "Array",
   "Array"
  ],
  "ACDamageOfElement": [
   "Array",
   "int",
   "Array",
   "Array"
  ],
  "ACDamageOfElementPercent": [
   "Array",
   "int",
   "Array",
   "Array",
   "Array",
   "Array"
  ],
  "ACDirectAttackDamageResistance": [
   "Array",
   "Array",
   "Array"
  ],
  "ACDirectDamage": [
   "Array",
   "Array",
   "Array"
  ],
  "ACFeverPoint": [
   "Array",
   "Array",
   "Array"
  ],
  "ACFixedSpeed": [
   "Array",
   "Array",
   "Array",
   "Array"
  ],
  "ACFlying": [
   "Array"
  ],
  "ACFrozen": [
   "Array",
   "Boolean"
  ],
  "ACGeneralBipolar": [
   "Array",
   "Array",
   "Array"
  ],
  "ACGuts": [
   "Array"
  ],
  "ACHealRejection": [
   "Array"
  ],
  "ACInvincible": [
   "Array"
  ],
  "ACOiuchi": [
   "Array",
   "Array",
   "Array"
  ],
  "ACParalysis": [
   "Array",
   "Boolean"
  ],
  "ACPiercing": [
   "Array"
  ],
  "ACPoison": [
   "Array",
   "Array",
   "Array"
  ],
  "ACPowerFlipComboCountDown": [
   "Array",
   "Array",
   "Array",
   "Array"
  ],
  "ACPowerFlipDamage": [
   "Array",
   "Array",
   "Array"
  ],
  "ACPowerFlipDamageResistance": [
   "Array",
   "Array",
   "Array"
  ],
  "ACRegeneration": [
   "Array",
   "Array"
  ],
  "ACSeparatedTermDirectDamage": [
   "Array",
   "Array",
   "Array"
  ],
  "ACSeparatedTermPowerFlipDamage": [
   "Array",
   "Array",
   "Array"
  ],
  "ACSilence": [
   "Array"
  ],
  "ACSkillDamage": [
   "Array",
   "Array",
   "Array"
  ],
  "ACSkillDamageResistance": [
   "Array",
   "Array",
   "Array"
  ],
  "ACSkillGaugeCharging": [
   "Array",
   "Array",
   "Array"
  ],
  "ACSpecialEfficacy": [
   "Array",
   "Array",
   "Array",
   "Array"
  ],
  "ACSpeedup": [
   "Array",
   "Array",
   "Array"
  ],
  "ACStun": [
   "Array",
   "Array",
   "Array"
  ],
  "ACSwift": [
   "Array"
  ],
  "ACToleranceOfDebuff": [
   "Array",
   "Array",
   "Array"
  ],
  "ACToleranceOfElement": [
   "Array",
   "int",
   "Array",
   "Array"
  ],
  "ACUnique": [
   "int",
   "Array"
  ]
 },
 "AttackHitEffect": {
  "Coarse": [],
  "CriticalSlash": [],
  "Dark": [],
  "Explosion": [],
  "Fine": [],
  "Fire": [],
  "Frozen": [],
  "None": [],
  "Shine": [],
  "Slash": [],
  "SpecifyHitEffectDirectly": [
   "Effect",
   "Boolean"
  ],
  "Splash": [],
  "ThunderLight": [],
  "ThunderSmall": [],
  "Tornado": []
 },
 "BarrierHitEffect": {
  "GenericBarrierHitEffect": [],
  "None": [],
  "SpecifyBarrierEffectDirectly": [
   "Effect"
  ]
 },
 "ColliderLifetime": {
  "SpecificFrame": [
   "int"
  ],
  "SpecificFrameSLv": [
   "Array"
  ],
  "UntilTargetTerminates": []
 },
 "ColliderShape": {
  "Circle": [
   "Array"
  ],
  "Rectangle": [
   "Array",
   "Array"
  ]
 },
 "ConditionHitEffect": {
  "GenericConditionHitEffect": [],
  "None": [],
  "SpecifyConditionHitEffectDirectly": [
   "Effect"
  ]
 },
 "ConvertToAttackFromKind": {
  "AbilityDamage": [],
  "DirectAttack": [],
  "PowerFlip": [],
  "SkillDamage": []
 },
 "CoordSys": {
  "AB": [],
  "CD": [],
  "EF": [],
  "GH": [
   "PosAndDirTrackingTarget"
  ]
 },
 "CoordSysSource": {
  "AB": [],
  "CD": [],
  "EF": [],
  "GH": [
   "int"
  ]
 },
 "DecreaseCoffinCountHitEffect": {
  "Generic": [],
  "Specific": [
   "Effect"
  ]
 },
 "DeleteConditionSyncMode": {
  "Default": [],
  "Once": []
 },
 "DeletionalConditionKind": {
  "DCAbilityDamage": [
   "int"
  ],
  "DCAbilityDamageResistance": [
   "int"
  ],
  "DCAdditionalDirectAttack": [],
  "DCAdversity": [
   "int"
  ],
  "DCAll": [
   "int"
  ],
  "DCAttackPoint": [
   "int"
  ],
  "DCBipolar": [],
  "DCBuffRejection": [],
  "DCComboBoost": [],
  "DCComboRestriction": [],
  "DCDamageOfElement": [],
  "DCDamageOfElementDetail": [
   "int"
  ],
  "DCDamageOfElementPercent": [],
  "DCDirectAttackDamageResistance": [
   "int"
  ],
  "DCDirectDamage": [
   "int"
  ],
  "DCFeverPoint": [
   "int"
  ],
  "DCFixedSpeed": [
   "int"
  ],
  "DCFlying": [],
  "DCFrozen": [],
  "DCGeneralBipolar": [],
  "DCGuts": [],
  "DCHealRejection": [],
  "DCInvincible": [],
  "DCOiuchi": [
   "int"
  ],
  "DCParalysis": [],
  "DCPiercing": [],
  "DCPoison": [],
  "DCPowerFlipComboCountDown": [
   "int"
  ],
  "DCPowerFlipDamage": [
   "int"
  ],
  "DCPowerFlipDamageResistance": [
   "int"
  ],
  "DCRegeneration": [],
  "DCSeparatedTermDirectDamage": [
   "int"
  ],
  "DCSeparatedTermPowerFlipDamage": [
   "int"
  ],
  "DCSilence": [],
  "DCSkillDamage": [
   "int"
  ],
  "DCSkillDamageResistance": [
   "int"
  ],
  "DCSkillGaugeCharging": [
   "int"
  ],
  "DCSpecialEfficacy": [
   "int"
  ],
  "DCSpeedup": [
   "int"
  ],
  "DCStun": [
   "int"
  ],
  "DCSwift": [],
  "DCToleranceOfDebuff": [
   "int"
  ],
  "DCToleranceOfElement": [
   "int"
  ],
  "DCToleranceOfElementDetail": [
   "int",
   "int"
  ],
  "DCUnique": [
   "int"
  ]
 },
 "Easing": {
  "BackIn": [],
  "BackOut": [],
  "CircIn": [],
  "CircOut": [],
  "CubicIn": [],
  "CubicOut": [],
  "ExpoIn": [],
  "ExpoOut": [],
  "Linear": [],
  "QuadIn": [],
  "QuadOut": [],
  "QuartIn": [],
  "QuartOut": [],
  "QuintIn": [],
  "QuintOut": [],
  "SineIn": [],
  "SineOut": []
 },
 "Effect": {
  "ResolveByElement": [
   "String",
   "int"
  ],
  "SpecifyEffectDirectly": [
   "String"
  ]
 },
 "EffectLifetime": {
  "PlayOnlyFirstSequence": [],
  "RemainingStateGroup": [],
  "SpecifyEffectLifetimeDirectly": [
   "int"
  ],
  "SpecifyEffectLifetimeSLv": [
   "Array"
  ],
  "UntilTargetTerminates": []
 },
 "EliminateAlterEgoTarget": {
  "All": [],
  "OnlyMyself": []
 },
 "EndingSpeedKind": {
  "KeepGoing": [],
  "RestoreToSpeedBeforeActionExecution": [],
  "RestoreToSpeedBeforeCommandExecution": [],
  "Stop": []
 },
 "FixedAttackHitEffect": {
  "Generic": [],
  "Specific": [
   "Effect",
   "Boolean"
  ]
 },
 "Formation": {
  "AShaped": [
   "int",
   "Number",
   "int",
   "Boolean"
  ],
  "Circle": [
   "int",
   "int"
  ],
  "File": [
   "int",
   "int",
   "Boolean"
  ],
  "Line": [
   "int",
   "int",
   "Boolean"
  ],
  "NWay": [
   "int",
   "Number"
  ],
  "Single": [],
  "WShaped": [
   "int",
   "Number",
   "int",
   "Boolean"
  ]
 },
 "HAlign": {
  "Center": [],
  "Left": [],
  "Right": []
 },
 "HealHitEffect": {
  "GenericHealHitEffect": [],
  "None": [],
  "SpecifyHealEffectDirectly": [
   "Effect"
  ]
 },
 "HitAreaGuardMode": {
  "None": [],
  "Suppress": [
   "int",
   "int",
   "ActionDslExpression"
  ]
 },
 "HitCountCheckTargetKind": {
  "DirectAttack": [],
  "PowerFlip": [],
  "Skill": [],
  "SkillChain": []
 },
 "IfTargetNotFound": {
  "CreateImaginaryTarget": [
   "int"
  ],
  "DoNothing": []
 },
 "LayerZDepth": {
  "BacksideOfCharacter": [],
  "ForesideOfCharacter": [],
  "NonPixelArt": [],
  "SameAsCharacter": [],
  "SuperForesideOfCharacter": []
 },
 "MinHitInterval": {
  "CalculatedUsingMaxNumOfHits": [
   "int"
  ],
  "CalculatedUsingMaxNumOfHitsSLv": [
   "Array"
  ],
  "SpecifyMinHitIntervalDirectly": [
   "Number"
  ],
  "SpecifyMinHitIntervalSLv": [
   "Array"
  ]
 },
 "ModifierFieldCancelTriggerSourceKind": {
  "AbilityDamage": [
   "int",
   "ModifierFieldCharacterTargetKind"
  ],
  "BallFlip": [
   "int"
  ],
  "Barrier": [
   "int",
   "ModifierFieldCharacterTargetKind"
  ],
  "Coffin": [
   "int",
   "ModifierFieldCharacterTargetKind"
  ],
  "Combo": [
   "int",
   "int"
  ],
  "ComboDisplay": [
   "int",
   "int"
  ],
  "Condition": [
   "int",
   "ModifierFieldCharacterTargetKind",
   "DeletionalConditionKind"
  ],
  "DamageByAbility": [
   "int",
   "ModifierFieldCharacterTargetKind"
  ],
  "DamageCount": [
   "int",
   "ModifierFieldCharacterTargetKind"
  ],
  "DamageCountByFriendlyFire": [
   "int",
   "ModifierFieldCharacterTargetKind"
  ],
  "DamageToEnemy": [
   "Number",
   "int"
  ],
  "Dash": [
   "int"
  ],
  "ElapsedTime": [],
  "EnemyCondition": [
   "int",
   "DeletionalConditionKind"
  ],
  "EnemyConditionCancelBuff": [
   "int"
  ],
  "EnemyKill": [
   "int"
  ],
  "Fever": [
   "int"
  ],
  "FeverEnd": [
   "int"
  ],
  "FeverPointAddedByAbility": [
   "int"
  ],
  "HealCount": [
   "int",
   "ModifierFieldCharacterTargetKind"
  ],
  "InvokeGuts": [
   "int",
   "ModifierFieldCharacterTargetKind"
  ],
  "MemberDirectAttack": [
   "int",
   "ModifierFieldCharacterTargetKind"
  ],
  "MultiballAppear": [
   "int",
   "Array"
  ],
  "MultiballRemove": [
   "int",
   "Array"
  ],
  "None": [],
  "PowerFlip": [
   "int"
  ],
  "PowerFlipHitLvHigh": [
   "int",
   "int"
  ],
  "PowerFlipLv": [
   "int",
   "int"
  ],
  "Revival": [
   "int",
   "ModifierFieldCharacterTargetKind"
  ],
  "SkillGauge": [
   "int",
   "ModifierFieldCharacterTargetKind"
  ],
  "SkillHit": [
   "int",
   "ModifierFieldCharacterTargetKind"
  ],
  "SkillInvoke": [
   "int",
   "ModifierFieldCharacterTargetKind"
  ],
  "SkillMax": [
   "int",
   "ModifierFieldCharacterTargetKind"
  ]
 },
 "ModifierFieldCharacterTargetKind": {
  "Member": [
   "int"
  ],
  "TotalOfParty": [
   "Array"
  ]
 },
 "ModifierFieldKind": {
  "AbilityDamage": [
   "Number"
  ],
  "AdditionalDirectAttack": [
   "int",
   "Number"
  ],
  "Adversity": [
   "Number"
  ],
  "Attack": [
   "Number"
  ],
  "BuffRejection": [],
  "ComboBoost": [
   "int"
  ],
  "ComboRestriction": [
   "int"
  ],
  "ConvertToAttack": [
   "ConvertToAttackFromKind",
   "Number"
  ],
  "DebuffResistance": [
   "Number"
  ],
  "DirectDamage": [
   "Number"
  ],
  "ElementResistance": [
   "int",
   "Number"
  ],
  "FeverPoint": [
   "Number"
  ],
  "Flying": [],
  "Frozen": [],
  "HealRejection": [],
  "Piercing": [],
  "PinchSlayer": [
   "Number"
  ],
  "PowerFlipDamage": [
   "Number"
  ],
  "Regeneration": [
   "int"
  ],
  "SeparatedTerm2ndDamage": [
   "SeparatedTerm2ndDamageKind",
   "Number"
  ],
  "Silence": [],
  "SkillDamage": [
   "Number"
  ],
  "SkillGaugeCharging": [
   "Number"
  ],
  "Slip": [
   "int"
  ],
  "Speedup": [
   "Number"
  ],
  "Stunify": [
   "Number"
  ]
 },
 "MultiballReadyEffect": {
  "E1": [
   "Effect"
  ],
  "E2": [
   "Effect",
   "Effect",
   "Effect"
  ]
 },
 "Option": {
  "None": [],
  "Some": [
   "Dynamic"
  ]
 },
 "SeparatedTerm2ndDamageKind": {
  "AbilityDamage": [],
  "All": [],
  "DirectAttack": [],
  "PowerFlip": [],
  "SkillDamage": []
 },
 "Shape": {
  "Arc": [
   "int",
   "Number"
  ],
  "Circle": [
   "Array"
  ],
  "Donut": [
   "int"
  ],
  "Rectangle": [
   "Array",
   "Array"
  ],
  "Sector": [
   "Array",
   "Array"
  ]
 },
 "ShieldDisplayKind": {
  "Normal": [],
  "Thin": []
 },
 "ShieldLifetime": {
  "Specify": [
   "int"
  ],
  "UntilStateGroupChanges": []
 },
 "ShieldMovementKind": {
  "Fixed": [
   "Number"
  ],
  "RotateAnticlockwise": [
   "Number",
   "int"
  ],
  "RotateClockwise": [
   "Number",
   "int"
  ],
  "Smart": [
   "Number",
   "int"
  ]
 },
 "ShockWaveShape": {
  "Arc": [
   "Number"
  ],
  "Donut": []
 },
 "SpawnAlterEgoPoint": {
  "CustomPosition": [
   "String"
  ],
  "UseMasterValue": []
 },
 "SpawnFunnelKind": {
  "Funnel": [
   "String"
  ],
  "StandardFunnel": [
   "String"
  ],
  "Zako": [
   "String"
  ]
 },
 "SpawnFunnelPoint": {
  "FunnelGroup": [
   "int"
  ],
  "Specific": [
   "int",
   "int",
   "int"
  ]
 },
 "TargetAttackLifetime": {
  "Specify": [
   "int"
  ],
  "StateGroupChangedAndWait": [
   "int"
  ]
 },
 "TweenSource": {
  "None": [],
  "Some": [
   "int",
   "Easing"
  ]
 },
 "VAlign": {
  "Bottom": [],
  "Center": [],
  "Top": []
 }
}


# ================================================================ 人工标注段(可维护)
# 命令中文名(未列出的显示英文原名)
CMD_CN = {
    "Trace": "调试输出", "RemoveEvent": "移除事件", "RemoveEventFromOwner": "移除自身事件",
    "FindAllSubjects": "选取对象(按条件)", "FindNearSubjects": "选取对象(最近N个)",
    "FindMultiballSubjects": "选取多球", "TargetMate": "选取队友",
    "ShakeCamera": "震屏", "AddSkillPoint": "增加技能量", "SubtractSkillPoint": "扣除技能量",
    "AddFeverPoint": "增加Fever值", "SubtractFeverPoint": "扣除Fever值", "AddCombo": "增加连击",
    "ShowEffect": "播放特效", "HideEffect": "隐藏特效", "HideEffectFromOwner": "隐藏自身特效",
    "MoveBall": "移动球", "StopBall": "停球",
    "CreateNormalAttack": "攻击(攻击力倍率)", "CreateRatioAttack": "攻击(当前HP比例)",
    "CreateFixedAttack": "攻击(固定值)", "CreateOnlyHitAttack": "攻击(仅命中判定)",
    "CreateNormalHeal": "治疗(固定值)", "CreateRatioHeal": "治疗(最大HP比例)",
    "CreateCondition": "赋予状态(buff/debuff)", "DeleteCondition": "移除状态",
    "ExtendCondition": "延长状态", "CreateHitArea": "创建攻击判定区", "MoveHitArea": "移动判定区",
    "RotateHitArea": "旋转判定区", "EraseHitArea": "删除判定区",
    "SetHitAreaSomeHitsWithAnyTargetHandler": "判定区命中回调(任意目标)",
    "SetHitAreaSomeHitsWithSpecificTargetHandler": "判定区命中回调(指定目标)",
    "SetHitAreaTerminateHandler": "判定区结束回调",
    "ConditionalsHitAreaHitCount": "条件:判定区命中数",
    "CreateReferencePoint": "创建参考点", "CreateReferencePointAtSpecifiedPosition": "参考点(指定坐标)",
    "CreateShockWaveAttack": "冲击波攻击", "CreateBombMultiball": "炸弹多球",
    "CreateSummonsMultiball": "召唤多球", "RemoveMultiball": "移除多球",
    "DecreaseCoffinCount": "减少棺材数", "Revive": "复活", "HideCharacter": "隐藏角色",
    "CreateWindAttack": "风压攻击", "CreateGravitationalField": "引力场",
    "CancelGravitationalField": "取消引力场", "CreateTornado": "龙卷风",
    "CreateTargetAttack": "目标攻击", "CreateOneWayWallGimmick": "单向墙",
    "RemoveOneWayWallGimmick": "移除单向墙", "SpawnFunnel": "召唤浮游炮",
    "EliminateFunnel": "消除浮游炮", "EliminateAllFunnel": "清空浮游炮",
    "SpawnAlterEgo": "召唤分身", "EliminateAlterEgo": "消除分身",
    "CreateShield": "创建护盾", "CancelShield": "取消护盾", "CreateBarrier": "创建屏障",
    "CreateFlood": "洪水", "CancelFlood": "取消洪水",
    "ConditionalsHealthPointRatio": "条件:HP比例", "ConditionalsHealthPointRatioOf": "条件:HP比例(指定对象)",
    "ConditionalsSkillPoint200Percent": "条件:技能量达200%", "ConditionalsFeverMode": "条件:Fever中",
    "ConditionalsCombo": "条件:连击数", "ConditionalsNumCoffins": "条件:棺材数",
    "IfThisCharacterIsBoss": "条件:自身是Boss", "IfThisCharacterIsSpecificBoss": "条件:自身是指定Boss",
    "IfThisCharacterIsSpecificFunnel": "条件:自身是指定浮游炮", "IfThisCharacterIsLeader": "条件:自身是队长",
    "ConditionalsNumExecutionsOddOrEven": "条件:第奇/偶数次发动",
    "ConditionalsNumExecutions2": "条件:按发动次数分支(2路)", "ConditionalsNumExecutions3": "条件:按发动次数分支(3路)",
    "ConditionalsNumExecutions4": "条件:按发动次数分支(4路)", "ConditionalsNumExecutions5": "条件:按发动次数分支(5路)",
    "ConditionalsConditionAccumulationNumber": "条件:状态层数", "ConditionalsConditionExist": "条件:持有状态",
    "ConditionalsMultiballNumber": "条件:多球数量", "ConditionalsUnifyElement": "条件:队伍属性统一",
    "ConditionalsMainOrUnison": "条件:主位/协力位", "ConditionalsRelativePositionVertical": "条件:相对位置(上下)",
    "ConditionalsProbability": "条件:概率", "ProbabilityWeight": "概率权重",
    "ConditionalsChangeSkillFlag": "条件:形态切换Flag", "ConditionalsCoffinCountSubject": "条件:棺材数(对象)",
    "ConditionalsCoffinCountFilter": "条件:棺材数(筛选)",
    "ChangeFieldAnimation": "场地动画", "ChangeFieldAssets": "更换场地资源",
    "SetPowerFilpSuppress": "抑制强化弹射", "StartPiercing": "开始贯通", "StopPiercing": "停止贯通",
    "StartBuffField": "开启增益领域", "StopBuffField": "停止增益领域",
    "StartModifierField": "开启修正领域", "StopModifierField": "停止修正领域",
    "ConsumeUniqueCondition": "消耗固有状态", "SuppressBallActivity": "抑制球活动",
    "SuppressSkill": "封印技能", "CreateCollider": "创建碰撞体", "RemoveCollider": "移除碰撞体",
    "RemoveColliderFromOwner": "移除自身碰撞体",
    "BindConditionAccumulationVariable": "绑定状态层数变量",
    "BindCoffinRevivalCountVariable": "绑定复活计数变量", "BindCoffinRevivalCountVariableOf": "绑定复活计数变量(指定)",
    "MultiballNumberVariable": "多球数量变量", "NotifyPowerflipEnd": "通知强化弹射结束",
    "RecoveryHitCountCheck": "回复命中计数检查", "CreateWallDistanceDetector": "墙距检测",
    "CreatePointsDistanceDetector": "点距检测",
    "ChangeBgm": "切换BGM", "FadeOutBgm": "BGM淡出",
    # 事件
    "Wait": "等待后执行", "Repeat": "循环执行", "CollisionOfBallAndEnemy": "球碰敌人时",
    "CollisionOfBallAndSpecificEnemy": "球碰指定敌人时",
    "CollisionOfSpecificBallAndSpecificEnemy": "指定球碰指定敌人时",
    "ActivatedMultiballOfExecutorSelf": "自身多球激活时",
}

# 状态词条(AdditionalConditionKind,CreateCondition 的 p2 列表元素)中文名
AC_CN = {
    "ACAttackPoint": "攻击力", "ACSkillDamage": "技能伤害", "ACAbilityDamage": "能力伤害",
    "ACAbilityDamageResistance": "能力伤害减免", "ACDirectAttackDamageResistance": "直击伤害减免",
    "ACPowerFlipDamageResistance": "强化弹射伤害减免", "ACSkillDamageResistance": "技能伤害减免",
    "ACToleranceOfElement": "属性耐性", "ACDamageOfElement": "属性追加伤害",
    "ACDamageOfElementPercent": "属性伤害%", "ACSpecialEfficacy": "特攻",
    "ACRegeneration": "再生(持续回复)", "ACPoison": "中毒", "ACInvincible": "无敌",
    "ACParalysis": "麻痹", "ACFrozen": "冻结", "ACBuffRejection": "强化无效",
    "ACHealRejection": "回复无效", "ACFeverPoint": "Fever值获取", "ACStun": "眩晕",
    "ACOiuchi": "追击", "ACToleranceOfDebuff": "弱体抗性", "ACPiercing": "贯通",
    "ACFlying": "浮游", "ACPowerFlipDamage": "强化弹射伤害", "ACDirectDamage": "直击伤害",
    "ACSilence": "沉默(封技)", "ACAdditionalDirectAttack": "直击追加攻击",
    "ACSpeedup": "加速", "ACAdversity": "逆境", "ACGuts": "不屈", "ACUnique": "固有状态",
    "ACComboBoost": "连击加成", "ACBipolar": "双极强化", "ACGeneralBipolar": "通用双极",
    "ACFixedSpeed": "固定球速", "ACSkillGaugeCharging": "技能自动充能",
    "ACComboRestriction": "连击维持", "ACPowerFlipComboCountDown": "强化弹射所需连击降低",
    "ACSeparatedTermPowerFlipDamage": "强化弹射伤害(分段)",
    "ACSeparatedTermDirectDamage": "直击伤害(分段)", "ACSwift": "迅捷",
}

# 参数中文标签(1 起;只标注有数据实例佐证的,其余前端显示类型名)
PARAM_CN = {
    "CreateCondition": {1: "作用对象ID(参考点/选取结果)", 2: "状态词条列表(AC*)", 4: "命中演出"},
    "CreateNormalAttack": {6: "攻击倍率(每段,SLv1→满级)"},
    "Wait": {1: "等待帧(60=1秒)", 2: "事件标签", 3: "到时执行"},
    "Repeat": {3: "事件标签", 4: "每次执行"},
    "StopBall": {1: "对象ID", 2: "持续帧"},
    "ShakeCamera": {1: "强度"},
    "AddSkillPoint": {1: "对象ID", 2: "数值"},
    "HideCharacter": {1: "对象ID", 2: "帧数"},
    "DeleteCondition": {1: "对象ID", 2: "状态类别", 5: "分组标识"},
    "ExtendCondition": {1: "对象ID", 2: "状态类别", 3: "延长帧"},
}

# AC* 常见三参数签名 [持续帧,强度,层数];单参数 = [持续帧](数据实例核对:
# ACAttackPoint(480帧=8秒, 0.5=+50%, 1层) / ACSkillDamage(900帧=15秒, 0.65=+65%))
AC_PARAM_CN = {1: "持续帧([SLv1,满级];60=1秒)", 2: "强度(0.5=50%)", 3: "层数"}

TYPE_CN = {
    "int": "整数", "Number": "小数", "Boolean": "布尔", "String": "字符串",
    "Array": "数组", "Object": "对象", "Dynamic": "任意", "Option": "可选",
    "ActionDslExpression": "子命令块", "AdditionalConditionKind": "状态词条",
    "ConditionHitEffect": "命中演出", "HealHitEffect": "治疗演出", "AttackHitEffect": "攻击演出",
    "DeletionalConditionKind": "状态类别", "HitCountCheckTargetKind": "命中检查对象",
    "CoordSysSource": "坐标系", "EndingSpeedKind": "结束速度", "Effect": "特效",
    "EffectLifetime": "特效时长", "ActionHitAreaLifetime": "判定区时长",
    "MinHitInterval": "最小命中间隔", "Shape": "形状", "HAlign": "水平对齐", "VAlign": "垂直对齐",
    "Formation": "阵型", "LayerZDepth": "图层", "TweenSource": "缓动",
    "SpawnFunnelKind": "浮游炮类型", "MultiballReadyEffect": "多球就绪特效",
    "HitAreaGuardMode": "判定区防御模式", "IfTargetNotFound": "目标缺失时",
}


def cn_cmd(name):
    return CMD_CN.get(name, name)


def _fmt_slv(v):
    """[{min,max}] / {min,max} → 'a→b' 或 'a'。"""
    if isinstance(v, list) and len(v) == 1 and isinstance(v[0], dict):
        v = v[0]
    if isinstance(v, dict) and "min" in v:
        a, b = v.get("min"), v.get("max")
        return f"{a:g}" if a == b else f"{a:g}→{b:g}"
    return None


def brief_command(arr) -> str:
    """["Command"/"Event",[名称,*参数]] 的内层数组 → 一句话简述(命令库列表用)。"""
    if not (isinstance(arr, list) and arr and isinstance(arr[0], str)):
        return ""
    name, params = arr[0], arr[1:]
    s = cn_cmd(name)
    if name == "CreateCondition" and len(params) >= 2 and isinstance(params[1], list):
        acs = []
        for ac in params[1]:
            if isinstance(ac, list) and ac and isinstance(ac[0], str):
                seg = AC_CN.get(ac[0], ac[0])
                dur = _fmt_slv(ac[1]) if len(ac) > 1 else None
                stren = _fmt_slv(ac[2]) if len(ac) > 2 else None
                if stren:
                    seg += f" {stren}"
                if dur:
                    seg += f"({dur}帧)"
                acs.append(seg)
        if acs:
            s += ": " + " + ".join(acs)
        return s
    bits = []
    for p in params[:6]:
        f = _fmt_slv(p)
        if f is not None:
            bits.append(f)
        elif isinstance(p, (int, float)) and not isinstance(p, bool):
            bits.append(f"{p:g}")
        elif isinstance(p, str) and p and len(p) < 24:
            bits.append(p)
    if bits:
        s += " (" + ", ".join(bits[:4]) + ")"
    return s
