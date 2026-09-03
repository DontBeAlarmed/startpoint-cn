# D20 Gacha Owner 与域内 Exchange 目标架构

本文固定 CN 1.8.1 普通 Gacha、Gacha 域内 Exchange、Crazy Gacha 与兑换点转换通知的目标边界。执行基线、checkpoint、审查和运行元数据保存在版本库外计划。

## 1. 目标与边界

D20 让 Gacha 拥有以下完整用例：

- typed banner、时期、page/prize kind、支付与 ticket/campaign 规则；
- 普通 draw 的计划、随机结果、Gacha-local movie/seed metadata；
- `players_gacha_info`、`players_gacha_campaigns`、兑换点与 Gacha receive history；
- Character/Equipment exchange 的产品资格、点数成本和原子事务；
- Crazy 候选、两个保存槽、最终选择和重登恢复；
- 兑换点到期转换通知及 `shown_converted` ack；
- Gacha-local typed result、提交后 effect 和 response projector。

Gacha 只协调用例，不取得以下最终状态所有权：

- Item/ticket 与重复角色补偿由 Inventory/RewardGrant 写入；
- Character acquisition、stack、bond-token 初始化与成长状态由 Character owner 写入；
- Equipment stack 由 Equipment owner 写入；
- paid/free Stone 由窄 Currency debit adapter 写入；
- Item overflow 继续使用 D18b disposition；
- Character Growth publication 继续是提交后 best-effort；
- Mission 只接收 Gacha fact；
- Content snapshot 生命周期仍由 ContentRepository 拥有。

明确排除：IAP Payment order/receipt、Star Crumb Exchange、Bond Token Exchange、Shop、Box Gacha、Tutorial receipt、D28 全局 Common Response、跨域 Exchange engine。

## 2. 客户端实际接口

CN 1.8.1 实际调用：

- `gacha/exec`；
- `gacha/exchange_character`；
- `gacha/exchange_equipment`；
- `gacha/shown_converted`；
- `gacha/crazy_gacha_save`；
- `gacha/crazy_gacha_select`。

本版本不存在独立 `gacha/index`、`gacha/payment`、`gacha/history` 或 `gacha/point` 请求。静态 banner 来自客户端 Master；动态状态由 `/load`、exec 和 exchange 响应携带。服务端不得为内部审计 history 或 payment adapter 发明客户端端点。

## 3. Content 事实

当前 Gacha Master 有 584 个 banner：493 Character、91 Equipment。实际 page kind 为：

| page kind | 数量 | 当前处置 |
|---:|---:|---|
| 0 Normal | 535 | 支持 |
| 1 TenTimesPerAccount | 20 | 支持 |
| 2 TicketOnly | 1 | 支持 |
| 3 OneTimeTicketOnly | 4 | 支持 |
| 4 TenTimesTicketOnly | 13 | 支持 |
| 5 CrazyTenTimesTicketOnly | 1 | 独立 Crazy 生命周期 |
| 6 OneTime | 0 | 客户端 TODO，不实施 |
| 7 TenTimes | 0 | 客户端 TODO，不实施 |
| 8 WithoutDaily | 10 | 支持 |

主表引用 5 个 rarity odds、795 个 Character odds、135 个 Equipment odds，合计 935 个动态引用，缺失为 0。当前 pool 有 109,263 个展开成员，但只有 40,281 个去重成员；运行目录按 odds identity 共享不可变 pool，不在每个 banner 复制。

普通 Gacha Campaign 有 41 个定义、161 条 campaign→gacha 关系和 145 个不同 gacha ID。旧 `gachaId→campaignId` 会覆盖 16 条历史关系，禁止继续作为 owner 输入。D20 保存全部定义、kind、时期和关系，并按 `gachaId + now + draw kind` 解析唯一有效 campaign。

Character/Equipment exchange rate 各有 3 条 actual rarity 规则，当前值均为 250。运行时必须读取 typed rate，不能把 250 当协议常量。

80 个 banner-configured ticket Item 全部命中 Item catalog。Character movie 实际使用 `normal`、`normal_guarantee`、`fes`、`fes_guarantee` 和明确跳过物理校验的 `rarity_5_guarantee`；Equipment 91 个 banner 全部命中 movie probability 1。

## 4. 时间语义

Gacha Master 调用客户端 `ParseTools.parseJstDataToUtcTime`，因此 banner、ticket expiry 和 Gacha Campaign 字符串按 UTC+9 解析，起止边界首尾包含。不得机械复用 Shop 的 UTC+8 period helper。

- `baseBannerPeriod` 保存 Master 时期；Comeback/Stars 使用玩家专属 `playerEffectivePeriod`，缺少时 fail closed，不退回 base period；
- 普通 Stone、paid daily与普通 campaign使用player-effective/base period；
- configured/wildcard ticket draw在玩家实际持有适用ticket时可延长到`ticket_expiry_time`；
- campaign同时要求banner和campaign自身时期有效；
- Exchange与同一客户端页面生命周期一致：base/player-effective期内开放；基础期结束后，玩家仍持有可合法延长该banner的ticket时延续到ticket expiry；
- page kind 5 仍要求 Crazy banner 有效；
- 管理千里眼只影响展示，不扩大执行期。

Catalog/owner分别解析`stoneDrawPeriod`、`paidDrawPeriod`、`campaignDrawPeriod`、`ticketDrawPeriod`、`exchangePeriod`与`conversionEligibleAt`。Conversion只在玩家已没有任何合法draw/exchange路径继续产生或消费该banner点数时触发。真实`25009`固定覆盖base结束、ticket尚有效且持券的draw/exchange/conversion边界。若以后又获得有效ticket并产生新点数，notification按第10节pending状态机累加或重开，不累计已展示历史，也不让点数滞留。

过期竞态统一使用客户端明确识别的 `1351`。Campaign 无有效定义和跨日分别可使用客户端明确识别的 `1361/1366`；其他失败返回通用有限错误，不猜官服编号。

## 5. Typed Gacha catalog

Catalog 以 `ReadonlyContentRepository` identity 为生命周期并 `WeakMap` 缓存，至少提供：

- `gachaId → CharacterBanner | EquipmentBanner`；
- `campaignId → full campaign definition`；
- `gachaId → ordered historical campaign IDs`；
- `(gachaId,itemId) → exchangeable pool item`；
- `(prize kind,rarity) → exchange point cost`；
- ticket policy、movie profile 与预计算 weighted pool；
- 5个Stars campaign definition、5个Stars banner flag、5个Comeback banner flag与对应玩家状态投影。

动态状态分为：Regular Campaign的`campaign_id+gacha_id+count`；Stars Campaign独立的`campaign_id+free_one_times+free_ten_times+player period`；Comeback独立player period。Stars/Comeback玩家时期属于状态，Login/account lifecycle通过窄初始化capability显式授予；缺少可证明资格输入时保持不可用，不猜enrolment。Stars两个免费次数不得压入普通campaign count，daily reset也分别更新。

Character/Equipment 是判别联合；page kind 是 schema union。Ticket-only/Crazy 等不适用 Stone 费用的页面必须表达为 `notApplicable`，不能用默认 150/1500/50 冒充 CDN 值。raw `cdndata/gacha*.json` 继续供客户端，不被 runtime typed shape 替换。

Seed catalog 是“客户端配置 + faithful 模拟推导”的独立只读 artifact，不进入 Content Registry，也不被 GachaCatalog 或 quarantine 可变状态拥有。

## 6. exec 请求合同

业务请求为 `{gacha_id,type,payment_type,number_of_exec}`。`payment_type` 必须与 `type` 一致：

| payment | 允许 type |
|---:|---|
| 1 free-first Stone | 1、2 |
| 2 paid-only Stone | 5、7 |
| 3 ticket | 3、4、9、10、12、13、14、20，且符合 prize/page/ticket |
| 4 campaign | 8、11，且符合 campaign kind |

数量规则：

- type 3/10/12 的单抽券：`number_of_exec` 为 1..10，结果数等于该值；
- type 20：固定 1；
- 其余普通/十连/ticket/campaign/Crazy：固定 1；
- 十连结果严格 10 个；单抽结果严格 1 个；
- 不允许 clamp 0、负数、小数、unsafe integer或 11+；
- type 14 在普通 execution owner 中 fail closed，只能进入 Crazy candidate owner。

type 7 是每账号一次的 paid-only 十连，不是 campaign single；费用来自 banner account-multi cost，结果 10 个，成功后 `is_account_first=false`。type 5 使用 banner `discountCost` 并将 `is_daily_first=false`。

兑换点增长在缺少官服后端证据时保持当前私服行为：普通立即提交 draw 每个实际奖品增加 1 点；Crazy 候选不增加可消费兑换点，最终选择也不重复增加。该策略不得表述为官服事实。

## 7. 普通 draw owner

唯一顺序：

```text
resolve authoritative banner/period/request plan
  → begin Gacha outer transaction
  → read Player and Gacha state once
  → read campaign state only when required
  → create one shared Inventory context
  → validate ticket/payment/campaign/count
  → persist Stone payment after-state or deduct ticket
  → draw using precomputed pools
  → create ordered typed prize plan
  → execute RewardGrant/Character/Equipment adapters
  → write receive history, Gacha state, campaign state and Mission facts
  → validate/project base success and return typed absolute result + postCommitEffects
  → commit
  → independently run seed marks, sampled logs and Growth publication, then return success
```

任一 payment、ticket、prize、overflow Mail、history、point、campaign、Gacha state 或 Mission 写入失败，整个事务回滚。Seed `markSent` 不得发生在提交前；失败事务不能留下可上报的 seed。

所有会使合法owner result无法投影的invariant在commit前验证；base response projector对合法typed result是total pure function。Seed mark、sampled log和Growth publication各自独立`try/catch`，任一失败只记录固定错误码，不能把已提交抽卡改成失败，也不能阻止其他effect。普通Character draw与Crazy candidate exec都只在事务提交后标记实际发送的seed；拒绝、回滚、save和select不新增seed mark。

## 8. Gacha 域内 Exchange

Character 与 Equipment 保留独立 command/HTTP/result，但共用 banner/rate/point 资格和 Gacha transaction owner：

1. 从Catalog与玩家状态解析并验证`exchangePeriod`和prize kind；普通banner使用base/player-effective period，玩家持有可延长该banner的configured/wildcard ticket时与客户端页面一起延续到ticket expiry；
2. O(1) 验证目标在 pool 且 `is_exchangeable=true`；
3. 按目标 rarity 与 prize kind读取 typed rate；
4. 验证并扣除该 banner 点数；
5. 通过 RewardGrant/资产 adapter 发放一个目标；
6. 写一条 receive history 与 Gacha info after-state；
7. Character 提交后做 Growth publication。

不增加“每目标只能兑换一次”的私服限制。点数不足、错池、不可交换或过期全部零写入；精确未知负向码不实施。

## 9. Crazy Gacha 生命周期

实际 page kind 5 必须与普通永久发奖分离：

- `exec(type=14,payment=3,number=1)`扣本轮Crazy ticket、生成10个候选identity与slot0恢复用display metadata、增加`crazy_draw_count`并替换slot0；不写普通Character/Equipment/history/兑换点；
- `crazy_gacha_save(index=1|2)` 要求 slot 0 存在且目标槽为空，将候选复制到目标槽；
- 再次 exec 只替换 slot 0，slot 1/2 保持；
- `crazy_gacha_select(index=0|1|2,gacha_id)`要求选中槽恰好10个Character ID，在一个事务内按选择时权威Character状态重新执行acquisition、写history并清除三槽/恢复结果；
- 重复 save/select、无槽、错 gacha 或过期均 fail closed；清槽后的重复 select 不重复发奖；
- `/load.crazy_gacha_result_list` 返回槽位→角色 ID 数组，`last_crazy_gacha_draw_result` 返回 slot 0 的完整 draw metadata用于重登恢复。

Slot 0/1/2的grant identity仅为`gachaId+ordered characterIds`。只有slot0额外保存`movieId/seed/candidate entryCount/candidate exBoostItem`作为恢复演出的display-only metadata；候选字段绝不能成为select最终资产事实。Select重新计算entry count、重复补偿和EX Boost outcome，并验证长度10、gacha一致、角色属于候选banner。

最大 draw 次数来自 `config.gacha_crazy_ten_max_count`，不硬编码。

## 10. 兑换点到期转换与 ack

当玩家已有Gacha info、已无合法draw/exchange路径且点数大于0时，`/load`的Gacha状态协调器在事务内：

- 将剩余点数按1:1请求Star Crumb；可容纳部分进入余额，超过`max_star_crumb`的部分进入无限Star Crumb Mail；
- 把 Gacha 点数设为 0；
- conversion、余额、overflow Mail与notification同事务，typed result保留requested/accepted/after/overflow/disposition；
- 维护唯一`(player,gacha)`pending notification：不存在时写入新点数；未展示时累加新点数；已经展示时用本次新点数覆盖旧pending；三种情况都置为未展示；
- `converted_gacha_list` 返回 `{gacha_id,gacha_exchange_point:当前pending_point}`，不是lifetime converted总数；
- `gacha/shown_converted` 只把通知标为已展示，不再次发资源；重复 ack 幂等；
- 已展示通知不在后续 load 重复返回。

这是基于客户端表现和既有“不丢资产、资源超限进入无限邮箱”政策确定的私服策略；官服触发时点和Star Crumb overflow去向仍为Official-Unknown。该窄adapter只复用Player absolute writer、Mail与投影，不复用Item sellable算法，也不调用D21 Exchange owner。

## 11. 持久状态与 daily reset

D20 schema 应支持：

- Gacha info 的 `crazy_draw_count`；
- Comeback/Stars player period与Stars独立one/ten次数；
- Crazy slot identity与slot0 display-only draw metadata；
- converted notification 的原点数、转换时点与 shown 状态；
- `players_gacha_info(player_id,gacha_id)` 与 `players_gacha_campaigns(player_id,gacha_id,campaign_id)` player-first indexes。

Daily reset外层事务仍由Player/login owner拥有，但通过Gacha state command对普通daily、Regular campaign与Stars one/ten状态分别执行有界集合UPDATE，不先list再逐行UPDATE。实际SQL条数由最终状态表模型和性能admission固定，不预设为恰好两条。

`api_count` 的跨端点、跨会话和自动重试身份未被客户端源码充分证明。D20 不用它发明 durable receipt；响应丢失后重复抽取继续作为已知边界记录，不伪造幂等保证。

## 12. 批量资产与性能

- Catalog 每 repository 构建一次；935 odds 读取使用小规模有界并发；
- pool 依 odds identity 共享，并预计算 total/cumulative weights和 exchangeable index；
- 1/10 抽 Character/Equipment 读取次数保持常数，按唯一 ID 批读、按 entry 顺序模拟、按唯一 ID写最终状态；
- receive history 可线性 batch INSERT，但不得线性读取；
- Player、Gacha state、campaign、Inventory static preload 均为固定读取；
- Gacha daily reset按最终状态模型执行固定数量的有界集合UPDATE；不得先list再逐行写，实际SQL数由C3 admission锁定；
- seed selection 不为每个奖品过滤并分配整个最大 19,056 seed bucket；稀疏拒绝采样后仅在异常时线性 fallback；
- 1/10 draw、ticket、campaign、两种 exchange、Crazy exec/save/select 分阶段记录事务 SQL、event-loop、payload bytes；
- 不用跨机器绝对 wall-clock 代替结构 admission。

## 13. 测试可达性

必须覆盖：

- active Character single/ten、Equipment ten、paid daily、account ten、configured/wildcard ticket、campaign single/ten；
- request 数字与 payment/type/page/prize 组合；
- banner/ticket/campaign 起止边界；
- Character seed/movie 稀有度，Equipment `treasure_up_type 0..3`；
- draw 与 draw_equipment 互斥及精确结果长度；
- Character/Equipment exchange 成功、点数边界、错池/不可交换/过期和 late rollback；
- Crazy exec/save/re-draw/select/retry/load recovery；
- converted load/ack/reload 幂等；
- `25009` ticket延长期内draw/exchange且不提前conversion，最后合法路径消失后才转换；
- Stars/Comeback缺player period fail closed、独立次数与load projection；
- post-commit seed/log/Growth逐项fault仍返回已提交成功；
- Crazy select忽略candidate entryCount/exBoost并按选择时状态重算；
- ticket、overflow、history、Gacha state、Mission fault 全事务回滚；
- 1/10 SQL 斜率、player-first query plan、seed allocation和 daily reset写入上界；
- 不注册 `gacha/index/payment/history/point`。

page kind 6/7 不建官方 E2E。畸形请求只保留 command/route guard，不构造与客户端按钮不可能产生的完整笛卡尔积。

## 14. 明确不实施

- 不修改官方 odds 或抽卡概率；
- 不复制官方 RNG，只保证 typed Master权重与保证位；
- 不把 seed artifact冒充官方 CDN seed表；
- 不实现 page kind 6/7；
- 不创建 Gacha index/payment/history/point端点；
- 不修复或并入 IAP Payment order/receipt；Payment replay 风险另立安全目标；
- 不实现通用 Exchange/Economy bus；
- 不吞并 Star Crumb、Bond Token、Shop、Box Gacha或 Tutorial receipt；
- 不猜未知官服错误码或 api_count 幂等语义。

## 15. 完成条件

- 584 banner、935 odds、41 campaign/161 relation、5 Stars definition/flag、5 Comeback flag与两类exchange rate无损进入runtime；
- 过期/future banner不可执行，ticket延长期和campaign kind正确；
- payment/type/count P0全部关闭；
- 普通 draw、两类 exchange、Crazy与conversion均由Gacha owner协调；
- route不拥有事务、资产writer或response业务；
- seed/log/Growth只在commit后；
- 1/10抽读取斜率固定、daily reset与player-first index通过；
- load与response为绝对after-state且重登一致；
-旧 route分支、硬编码250、有损campaign map和重复fixture删除；
-所有focused/performance、独立whole-range审查通过。
