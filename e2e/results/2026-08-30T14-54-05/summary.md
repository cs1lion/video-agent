# E2E 批次报告

- 服务：`http://127.0.0.1:8790`
- 开始：2026/8/30 22:54:05
- 用例：3 个，PASS 2 / FAIL 1

| 用例 | 标题 | 音频形态 | 耗时 | 终态 | 质检 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| S1-late-radio | 《深夜电台》· 主播×连线司机 · 四轮对讲 | dialogue | 823s | done | 82（pass） | FAIL |
| S2-watchmaker | 《修表匠与大学生》· 五轮对讲 · 长镜对白 | dialogue | 558s | done | 90（pass） | PASS |
| S3-tower-night | 《塔台夜班》· 管制员×机长 · 四轮对讲 + 冷调 BGM | dialogue+bgm | 457s | done | 84（warn） | PASS |

## 明细

- [S1-late-radio 《深夜电台》· 主播×连线司机 · 四轮对讲](./S1-late-radio-late-night-radio/report.md) — FAIL
- [S2-watchmaker 《修表匠与大学生》· 五轮对讲 · 长镜对白](./S2-watchmaker-watchmaker-dialogue/report.md) — PASS
- [S3-tower-night 《塔台夜班》· 管制员×机长 · 四轮对讲 + 冷调 BGM](./S3-tower-night-tower-control-night/report.md) — PASS