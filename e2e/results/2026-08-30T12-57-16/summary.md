# E2E 批次报告

- 服务：`http://127.0.0.1:8790`
- 开始：2026/8/30 20:57:16
- 用例：3 个，PASS 2 / FAIL 1

| 用例 | 标题 | 音频形态 | 耗时 | 终态 | 质检 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| F1-modern-alley | 《深巷面馆》· 现代中国都市 · 台词驱动 | dialogue | 377s | done | 87（warn） | FAIL |
| F2-ancient-bianjing | 《汴河夜雨》· 北宋汴京 · 台词驱动 | dialogue | 521s | done | 85（pass） | PASS |
| F3-republic-ferry | 《三峡夜航》· 1937 长江客轮 · 台词 + BGM | dialogue+bgm | 503s | done | 88（fail） | PASS |

## 明细

- [F1-modern-alley 《深巷面馆》· 现代中国都市 · 台词驱动](./F1-modern-alley-alley-noodle-modern/report.md) — FAIL
- [F2-ancient-bianjing 《汴河夜雨》· 北宋汴京 · 台词驱动](./F2-ancient-bianjing-bianjing-rain-night/report.md) — PASS
- [F3-republic-ferry 《三峡夜航》· 1937 长江客轮 · 台词 + BGM](./F3-republic-ferry-yangtze-ferry-1937/report.md) — PASS