# 事件链与模型链压测（B-61）

> 生成时间：2026-09-21T18:14:10.681Z

## 模型链（mock 池）
- 模型：deepseek-v4-flash / glm-5.3-flash / qwen-3.8-flash
- 延迟：n=60 p50=0.001ms p95=0.005ms mean=0ms max=0.037ms

## 事件链（内存总线 append→ack）
- 写入吞吐：264773.9 次/秒
- 延迟：n=300 p50=0.001ms p95=0.002ms mean=0ms max=0.654ms