# 价格与权益确认单（模板）

> 用途：价格/权益类内容与券上架前的客户确认凭证（DEC-06）。确认后变更即冻结相关
> 内容、话术与投放，重新确认前不得发布。生成与确认回执进事件账本（只增不改）。

## 一、主体信息
- 门店/主体：{{property_name}}
- 确认单编号：{{confirmation_id}}
- 确认人：{{customer_contact}}（客户方授权代表）
- 确认时间：{{confirmed_at}}

## 二、价格口径（明码标价）
- 门市价：{{list_price}} 元/间夜
- 划线价：{{strike_price}} 元/间夜（依据：{{strike_price_basis}}；不得虚构原价）
- 到手价：{{final_price}} 元/间夜（含/不含：{{inclusions}}）
- 适用日期：{{valid_from}} 至 {{valid_to}}；不适用日期：{{blackout_dates}}
- 库存与稀缺说明：{{inventory_note}}（不得制造虚假稀缺）

## 三、权益与限制
- 含早/加床/延迟退房等权益：{{benefits}}
- 使用范围：{{usage_scope}}（平台 / 门店 / 房型）
- 限制条件：{{restrictions}}

## 四、退改与核销（在线旅游与预售券）
- 退改规则：{{refund_policy}}（以平台规则与法律法规为准，不得低于法定下限）
- 核销方式：{{redemption_method}}；核销有效期：{{redemption_deadline}}
- 逾期未核销处理：{{expiry_handling}}
- 平台与商家责任划分：{{responsibility_split}}

## 五、合规确认
- [ ] 明码标价、划线价与到手价口径真实，不制造虚假稀缺
- [ ] 退改与核销规则完整，不低于平台规则与法定下限
- [ ] 权益描述与实际可兑付一致，无「最终解释权」等无效条款
- [ ] 变更将冻结相关物料与话术，重新确认后方可发布

客户确认（签字/电子确认）：____________________  日期：{{confirmed_at}}
