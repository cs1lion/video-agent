/**
 * Clarifier 类型定义 —— 前期访谈（grill）与富化简报（doc）的核心数据结构。
 *
 * 数据流：Brief（一句话需求）
 *   → 访谈（10 条固定风格界限题 + 5 条按需求定制的 LLM 题）→ Intent（维度/题目 → 答案）
 *   → GenerationDirectives（各生成阶段的 prompt 注入指令）
 *   → EnrichedBrief（交给管线的最终文档，可附 GenerationOptions）。
 */
export {};
