# 场景覆盖审计表（B-60）

> 三包声明条目：52｜场景并集：26｜审计行：78｜缺口：26

| 场景 | geo-growth | hotel | ai-video |
|---|---|---|---|
| ask-synthesize | L1/L2/L3 | L1/L2/L3 | L1/L2/L3 |
| briefing | L1/L2/L3 | L1/L2/L3 | L1/L2/L3 |
| campaign-strategy | L3/L3/L3 | generic(L2) | generic(L2) |
| ceo-decision | L1/L2/L3 | L1/L2/L3 | L1/L2/L3 |
| ceo-deep-analysis | L3/L3/L3 | L3/L3/L3 | L3/L3/L3 |
| comment-classify | L1/L1/L1 | L1/L1/L2 | L1/L1/L1 |
| content-generate | L1/L2/L3 | L1/L2/L3 | L1/L2/L3 |
| cs-answer | L1/L1/L2 | L1/L1/L2 | L1/L1/L1 |
| director-review | generic(L2) | generic(L2) | L1/L2/L3 |
| fast-scan-report | L3/L3/L3 | L3/L3/L3 | L3/L3/L3 |
| funnel-analyze | L1/L2/L3 | generic(L2) | generic(L2) |
| geo-content | L1/L2/L3 | generic(L2) | generic(L2) |
| hr-replacement | L3/L3/L3 | L3/L3/L3 | L3/L3/L3 |
| incident-rootcause | generic(L2) | L3/L3/L3 | generic(L2) |
| intent-classify | L1/L1/L1 | L1/L1/L1 | L1/L1/L1 |
| kb-extract | L1/L2/L3 | L1/L2/L3 | L1/L2/L3 |
| keyword-research | L1/L2/L3 | generic(L2) | generic(L2) |
| lead-qualify | L1/L2/L3 | generic(L2) | generic(L2) |
| night-report | generic(L2) | L1/L2/L3 | generic(L2) |
| nl-translate | L1/L1/L1 | L1/L1/L1 | L1/L1/L1 |
| preproduction | generic(L2) | generic(L2) | L1/L2/L3 |
| prompt-fusion | generic(L2) | generic(L2) | L1/L2/L3 |
| quest-plan | L1/L2/L3 | L1/L2/L3 | L1/L2/L3 |
| reconcile-analyze | generic(L2) | L1/L2/L3 | generic(L2) |
| review-reply | generic(L2) | L1/L2/L3 | generic(L2) |
| voice-concierge | generic(L2) | L1/L1/L1 | generic(L2) |

## 缺口

- [geo-growth] director-review：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [geo-growth] incident-rootcause：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [geo-growth] night-report：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [geo-growth] preproduction：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [geo-growth] prompt-fusion：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [geo-growth] reconcile-analyze：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [geo-growth] review-reply：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [geo-growth] voice-concierge：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [hotel] campaign-strategy：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [hotel] director-review：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [hotel] funnel-analyze：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [hotel] geo-content：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [hotel] keyword-research：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [hotel] lead-qualify：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [hotel] preproduction：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [hotel] prompt-fusion：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [ai-video] campaign-strategy：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [ai-video] funnel-analyze：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [ai-video] geo-content：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [ai-video] incident-rootcause：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [ai-video] keyword-research：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [ai-video] lead-qualify：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [ai-video] night-report：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [ai-video] reconcile-analyze：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [ai-video] review-reply：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移
- [ai-video] voice-concierge：场景未在本包声明（其他包已声明）→ 将回退 generic L2，档位与成本口径漂移