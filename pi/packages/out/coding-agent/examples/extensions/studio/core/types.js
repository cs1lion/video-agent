/**
 * Shared types for the studio multi-agent video production system.
 */
// ============================================================================
// Pipeline stages
// ============================================================================
export const PIPELINE_STAGES = [
    "brief",
    "script",
    "visual",
    "direction",
    "storyboard",
    "shots",
    "audio",
    "edit",
    "delivery",
];
export const STAGE_LABELS = {
    brief: "创意简报",
    script: "剧本",
    visual: "美术设计",
    direction: "镜头阐述",
    storyboard: "分镜表",
    shots: "镜头生成",
    audio: "音频制作",
    edit: "剪辑成片",
    delivery: "交付",
};
export const TASK_STATUS_ICONS = {
    pending: "○",
    running: "◐",
    completed: "✓",
    failed: "✗",
    reopened: "↻",
    blocked: "⊘",
};
export const ARTIFACT_STATUS_ICONS = {
    submitted: "…",
    approved: "✓",
    rejected: "✗",
};
export const ARTIFACT_KIND_LABELS = {
    brief: "创意简报",
    script: "剧本",
    "visual-bible": "美术设计",
    "shot-list": "镜头阐述",
    storyboard: "分镜表",
    image: "设定图",
    video: "镜头视频",
    audio: "配音",
    music: "配乐",
    "final-cut": "成片",
    report: "制作报告",
    other: "其他",
};
