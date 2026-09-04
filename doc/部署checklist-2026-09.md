# 部署 checklist · video-agent-server 2026-09

> 范围：本次会话累计的 5 个 fix + 3 类 LLM-as-judge 偏置治理
> 部署目标：测试环境 / 灰度生产
> 部署后必做：观察 1 周，根据用户反馈调整

## 一、本次变更清单（git 范围）

### Server 代码（pi/packages/video-agent-server/）
| 文件 | 变更 | 单测 | 风险 |
|------|------|------|------|
| `src/prompts.ts` | + voice-cast gender 池（已合并） | voice-cast.test.ts 13/13 ✅ | 低 |
| `src/prompts.ts` | + coSpaceBlock 输出 `(男/女)` 标注 | — | 低（1 行） |
| `src/prompts.ts` | + shotPromptMessages 4b 规则（强制具体名） | — | 中（可能触发 Agnes 策略） |
| `src/prompts.ts` | + shotPromptMessages 6. 画面构图约束（focus speaking character） | — | 中 |
| `src/pipeline.ts` | + normalizeShotPrompts 接受 designBible 参数 | — | 低 |
| `src/pipeline.ts` | + injectCharacterLooks 函数 | inject-character-looks.test.ts 6/6 ✅ | 低 |
| `src/stages/visual-derive.ts` | + backfillEnglishNames（coSpace→design 同步 englishName） | — | 低 |
| `src/stages/script.ts` | + scriptIntent 早返回路径（跳过 LLM 编剧） | — | 中 |
| `src/stages/export.ts` | + camera-motion 兜底 | camera-motion.test.ts 12/12 ✅ | 低 |
| `src/server.ts` | + coSpaceFromBody 透传 englishName/scriptIntent | — | 低 |

### Shared Schema（pi/packages/video-agent/）
| 文件 | 变更 |
|------|------|
| `src/clarify/types.ts` | + CoCharacter.gender 字段 |
| `src/clarify/types.ts` | + CoCharacter.englishName 字段 |
| `src/clarify/types.ts` | + CoCreationSpace.scriptIntent 字段 |

### E2E 工具（e2e/）
| 文件 | 变更 | 风险 |
|------|------|------|
| `e2e/deep-review.mjs` | + ground-truth 字段（userScriptIntent / 末镜groundTruth） | 低 |
| `e2e/deep-review.mjs` | + 末镜偏置自动校验（ground-truth 反驳） | 低 |
| `e2e/deep-review.mjs` | + `末镜groundTruth_checkClaim` 关键词匹配 | 低 |

### Runner（doc/scripts/dense-dialogues/）
| 文件 | 变更 |
|------|------|
| `run-scripts-v2.mjs` | + 解析 `（英文名，男/女，X 岁）` 格式 |
| `run-scripts-v2.mjs` | + coSpace 注入 englishName + scriptIntent |
| `run-scripts-v2.mjs` | + ESM main guard（防被 import 时自动执行 main） |
| `run-scripts.mjs` / `run-scripts.js` | ⚠️ DEPRECATED 标注 |
| `run-single.mjs` | 新增（单脚本跑批） |
| `collect-run.mjs` | 新增（手动补抓 done run 产物） |
| `build-summary.mjs` | 新增（深审汇总） |
| `compare-all6-batches.mjs` | 新增（跨 batch 对比） |
| `compare-review.mjs` | 新增（两轮深审 diff） |
| `script-01..06-*.md` | 6 部剧本（5 原剧 + 1 压力测试）补 `(英文名，男/女，X 岁)` |

## 二、部署前 checklist

### 自动化检查（必须通过）

- [ ] **单元测试**：server 全部 295+ 通过（已知 2 个 step-tts 在线 401 与本次无关）
  ```bash
  cd pi/packages/video-agent-server && npm test
  ```
- [ ] **TypeScript 类型检查**：server 与 shared 全部无 error
  ```bash
  cd pi/packages/video-agent-server && npx tsc --noEmit -p tsconfig.json
  cd ../video-agent && npx tsc --noEmit -p tsconfig.json
  ```
- [ ] **构建**：monorepo 完整构建
  ```bash
  cd pi && npm run build
  ```
- [ ] **all6 v3 实跑**：跑完 6 部 + deep-review，0 个 cross-gender 错配
  ```bash
  cd pi/packages/video-agent-server
  # 启动 server
  cd ../../../..
  node doc/scripts/dense-dialogues/run-scripts-v2.mjs
  node e2e/deep-review.mjs e2e/results/<latest-batch>
  ```

### 人工检查（建议但非阻塞）

- [ ] **已知问题清单已同步给客服/产品**（见后文"七、已知问题"）
- [ ] **现有用户脚本迁移指南就绪**（用户脚本需补 `(Lin, 男, 35 岁)` 格式）
- [ ] **Agnes 视频生成 quota 充足**（6 部 ≈ 25 秒 × 6 = ~2.5 分钟单部，共 ~15 分钟视频生成）
- [ ] **环境变量就绪**：`PORT=8790` `VIDEO_AGENT_QUOTA_DAILY_SEC=0` `VIDEO_AGENT_AUTO_REPAIR=1`

## 三、部署步骤

### 测试环境

```bash
# 1. 拉代码
cd pi
git pull

# 2. 装依赖 + 构建
npm install
npm run build

# 3. 启动 server（带 quota 关闭 + auto-repair）
cd packages/video-agent-server
PORT=8790 VIDEO_AGENT_QUOTA_DAILY_SEC=0 VIDEO_AGENT_AUTO_REPAIR=1 npx tsx src/server.ts
```

### 灰度生产

- [ ] 在 5% 流量观察 3 天
- [ ] 监控指标：脚本生成成功率、视频生成成功率、deep-review confirmed 比例
- [ ] 任何确认回归（cross-gender 错配、字幕错位、douban 配音）需要立刻回滚

### 回滚

```bash
# 立即回滚
git revert HEAD

# 或精确回滚（保留后续无关 commit）
git revert <deploy-commit-sha>

# 重启 server
```

## 四、配置变更

### 环境变量
- **新增**：无
- **修改**：无
- **现有保留**：`PORT`, `VIDEO_AGENT_QUOTA_DAILY_SEC`, `VIDEO_AGENT_AUTO_REPAIR`（演示期配置）

### Models.json
- **新增**：无
- **修改**：无
- **注意**：`coSpaceBlock` 注入 gender 的修复**不依赖 models.json 变更**

## 五、数据库迁移

- **无**。本次变更全部在内存中生效，不需要数据库迁移。

## 六、API 兼容性

### 新增字段
- `CoCharacter.englishName?: string` —— 可选，向后兼容
- `CoCreationSpace.scriptIntent?: { title?, logline?, shots: [...] }` —— 可选，向后兼容
- `DesignEntity.englishName?: string` —— 可选，向后兼容

### 字段行为变更
- `CoCharacter.gender?: "male" | "female"` —— 新增，可选，老调用不传仍走 regex 兜底
- `voicePoolForDescription(text, gender?)` —— 新增第二参数，向后兼容（不传仍按 regex 判定）
- `normalizeShotPrompts(doc, script, bible, designBible?)` —— 新增第四参数，可选

### 行为变化（已就绪）
- 用户脚本**不带英文名**：visual prompt 不会被强制使用英文名（提示 4b 仅作为建议），跨镜一致性可能不如带英文名的脚本
- 用户脚本**带英文名**：跨镜人物一致性提升（v3 6 部 0 个 cross-gender 错配）
- 用户脚本**带 scriptIntent**：跳过 LLM 编剧直接采用 user 设计，user 设计有 bug 也不会被 LLM 修复

## 七、已知问题（必须告知用户）

### 真问题（影响产品体验）

| 问题 | 频率 | 影响 | 何时修 |
|------|------|------|--------|
| **嘴不动 dubOver=True** | 100% dialogue 镜 | 配音替换了视频原音轨，但视频里嘴没动 | 视频模型跟读限制，下季度 |
| **字幕错字** | ~5% 概率 | 多字/漏字/同音字错误 | 下季度，加 token-level diff |
| **末镜字幕超出视频（F剧 SH08）** | 长视频末镜 | 字幕 end > final.mp4 duration，字幕显示被截 | 下季度，video 末尾多预留缓冲 |
| **声画归属错位** | F剧 SH07 验证 | 字幕归属正确但画面焦点在听话人 | 本轮已加 visual prompt focus 约束，待 v4 验证 |

### 假阳性（影响 deep-review 报告可信度）

| 问题 | 修复状态 |
|------|----------|
| 末镜偏置 5/6 报缺失（实际都在） | ✅ 已修——本轮加 ground-truth 自动反驳 |
| 末时点偏置（model 报视频短于实际 4s） | ❌ 未修 |
| 设计脑补（model 编造不存在的设计） | ✅ 部分修——本轮加 userScriptIntent ground truth |
| 评分尺度飘移（单轮方差大） | ⚠️ 双轮交集缓解，未根治 |

## 八、监控指标（建议）

| 指标 | 期望 | 告警阈值 |
|------|------|----------|
| 跑批成功率 | > 95% | < 90% 告警 |
| 单 run 平均时长 | < 15 分钟 | > 30 分钟告警 |
| deep-review confirmed 数（每部剧） | < 5 | > 10 告警 |
| cross-gender 错配数 | 0 | > 0 立即告警 |
| 配音音色错配数 | 0 | > 0 立即告警 |
| 字幕行数 = 镜数 | 100% | < 95% 告警 |
| dubOver=True 比例（dialogue 镜） | 当前 100%，**已知问题** | — |

## 九、变更日志（changelog）

### v3（2026-09-01）—— 本次部署

#### Fixes
1. **voice-cast gender 注入**：CoCharacter.gender 字段 + voicePoolForDescription 第二参数
2. **coSpaceBlock gender 标注**：visual prompt 注入 `(男/女)`，避免 LLM 自由脑补默认女性
3. **camera-motion 兜底**：export 阶段检测 clip prompt 运镜词，邻镜含运镜词 + 非 cut 转场 → 强制 cut
4. **scriptIntent schema**：用户逐镜剧本意图作为 ground truth，server 编剧阶段跳过 LLM 直接采用
5. **injectCharacterLooks + englishName**：visual prompt 提到角色名时自动注入外貌短语，避免跨镜人物错配

#### LLM-as-judge 治理
1. **ground-truth 字段**：design JSON 加 `userScriptIntent` 和 `末镜groundTruth` 两个 ground-truth 字段
2. **末镜偏置自动校验**：deep-review 末镜"缺失/中断/未呈现"类报告自动被 ground-truth 反驳（已通过 v3 6 部剧验证）

#### Runner & 工具
- `run-scripts-v2.mjs`：闸门处理 + scriptIntent 注入 + englishName 注入 + ESM main guard
- `run-single.mjs`：单脚本跑批
- `collect-run.mjs`：补抓 done run 产物
- `compare-all6-batches.mjs`：跨 batch 对比表
- `build-summary.mjs`：deep-review 汇总

#### Schema
- CoCharacter: + gender, + englishName
- CoCreationSpace: + scriptIntent
- DesignEntity: + englishName

### v2（之前批次）
- voice-cast 13/13 测试用例
- 仅 doc 报告与 runner 升级

### v1（最初）
- 原始 run-scripts.mjs（已 DEPRECATED）

## 十、回滚预案

### 触发条件
- 跑批成功率 < 80%
- 出现 cross-gender 错配（之前 0）
- confirmed 数普遍 > 10（之前 < 5）
- 用户报告"对着错性别说话"重新出现

### 回滚步骤

```bash
# 1. 立即关停新流量（如果有负载均衡）
# 2. 回滚代码
cd pi
git revert HEAD --no-edit

# 3. 重启 server
cd packages/video-agent-server
pkill -f 'tsx src/server.ts'  # kill 旧进程
PORT=8790 VIDEO_AGENT_QUOTA_DAILY_SEC=0 VIDEO_AGENT_AUTO_REPAIR=1 npx tsx src/server.ts &

# 4. 验证回滚成功
curl -s http://127.0.0.1:8790/api/health
# 应该返回 {"ok":true,...}

# 5. 通知相关方 + 创建 incident report
```

### 已知降级行为（回滚后）
- 不再使用 scriptIntent（用户脚本只有 logline 透传）
- 不再使用 injectCharacterLooks（跨镜人物可能错配）
- 不再使用 ground-truth 自动反驳（deep-review 报告末镜缺失会增加）
- voice-cast 仍正常（gender 字段可选）
- camera-motion 仍正常

## 十一、附录

### A. 跨 batch 跑批对比

详见 `doc/reports/compare-all6-batches.md`

### B. 完整 fix 报告

- `doc/reports/信息保留+拼接感修复闭环-2026-09-01.md`（fix 1+2 闭环）
- `doc/reports/配音性别修复验证报告-2026-08-31.md`（fix voice-cast 闭环）
- `doc/reports/历史踩坑补遗-第二轮-2026-09-01.md`（11 个新坑）
- `doc/reports/all6-englishName-完整闭环报告-2026-09-01.md`（injectCharacterLooks 闭环）
- `doc/reports/第三轮跑批与系统偏置发现-2026-09-01.md`（4 类 LLM-as-judge 偏置）
- `doc/reports/第五轮跑批-跨镜人物一致性根治-2026-09-01.md`（injecCharacterLooks 链路）

### C. 测试产物

- `e2e/results/2026-09-01T09-30-all6-englishName/` —— 6 部 v3 跑批结果
- `e2e/results/2026-09-01T03-30-all6-final/` —— 6 部 v2 跑批结果
- `e2e/results/2026-08-31T12-14-22/` —— 6 部 v1 原始跑批结果

### D. 关键代码位置

- `pi/packages/video-agent/src/clarify/types.ts` —— schema 入口
- `pi/packages/video-agent-server/src/voice-cast.ts` —— 配音分配
- `pi/packages/video-agent-server/src/prompts.ts` —— 全部 prompt 模板
- `pi/packages/video-agent-server/src/pipeline.ts` —— `normalizeShotPrompts` + `injectCharacterLooks`
- `pi/packages/video-agent-server/src/stages/script.ts` —— scriptIntent 早返回
- `pi/packages/video-agent-server/src/stages/visual-derive.ts` —— backfillEnglishNames
- `pi/packages/video-agent-server/src/stages/export.ts` —— camera-motion 兜底
- `e2e/deep-review.mjs` —— ground-truth + 末镜偏置反驳

---

**最后更新**：2026-09-01 by MiniMax-M3
**部署决策**：建议先观察 all6 v4（含本次 fix 1+2）1-2 周，确认无 regression 后再上灰度
