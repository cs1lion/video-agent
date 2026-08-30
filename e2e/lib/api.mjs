/**
 * 极简 API 客户端（只依赖 Node 18+ 内置 fetch，无第三方包）。
 * 与 video-agent-server 的 REST 契约一一对应。
 */

export class ApiError extends Error {
	constructor(status, message, body) {
		super(`HTTP ${status}: ${message}`);
		this.status = status;
		this.body = body;
	}
}

async function request(base, method, path, body) {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: body === undefined ? {} : { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	let json;
	try {
		json = text ? JSON.parse(text) : {};
	} catch {
		json = { raw: text };
	}
	if (!res.ok) throw new ApiError(res.status, json?.error ?? text.slice(0, 200), json);
	return json;
}

export const api = {
	/** 服务是否活着 + 媒体适配器/价格目录概览 */
	async health(base) {
		try {
			return await request(base, "GET", "/api/health");
		} catch {
			// 老版本无 /api/health：退化成拉项目列表探测
			try {
				await request(base, "GET", "/api/runs");
				return { ok: true, degraded: true };
			} catch (e) {
				throw e;
			}
		}
	},

	/** 启动一次生成。body: { brief, options?, coSpace?, imageIds? } */
	generate: (base, body) => request(base, "POST", "/api/generate", body),

	/** RunView（含 stages / status / gate / events / verdict） */
	getRun: (base, runId) => request(base, "GET", `/api/runs/${encodeURIComponent(runId)}`),

	/** 文本产物 + 资产清单 */
	artifacts: (base, runId) => request(base, "GET", `/api/runs/${encodeURIComponent(runId)}/artifacts`),

	/** 确认推进；关键帧闸门可传 confirmedShotIds 做部分确认 */
	resume: (base, runId, confirmedShotIds) =>
		request(base, "POST", `/api/runs/${encodeURIComponent(runId)}/resume`, {
			...(confirmedShotIds ? { confirmedShotIds } : {}),
		}),

	/** 上传/替换 BGM（dataUrl 形式） */
	uploadBgm: (base, runId, name, dataUrl) =>
		request(base, "POST", `/api/runs/${encodeURIComponent(runId)}/bgm`, { name, dataUrl }),

	/** 读取一致性预检结果 */
	consistency: (base, runId) => request(base, "GET", `/api/runs/${encodeURIComponent(runId)}/consistency`),

	/** 运行追踪 spans */
	traces: (base, runId) => request(base, "GET", `/api/runs/${encodeURIComponent(runId)}/traces`),

	/** 下载 run 目录内任意文件（返回 Buffer） */
	async downloadFile(base, runId, relPath, timeoutMs = 120_000) {
		const url = `${base}/api/runs/${encodeURIComponent(runId)}/files/${relPath
			.split(/[\\/]/)
			.map(encodeURIComponent)
			.join("/")}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetch(url, { signal: controller.signal });
			if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => "").then((t) => t.slice(0, 200)));
			return Buffer.from(await res.arrayBuffer());
		} finally {
			clearTimeout(timer);
		}
	},

	// ---- 成片之后的动作（重做 / 自审 / 制片主任 / 多画幅 / 组合出片 / 度量）----

	/** 镜头补拍（异步执行，返回后 run 状态转 running） */
	reshot: (base, runId, shotId, instruction) =>
		request(base, "POST", `/api/runs/${encodeURIComponent(runId)}/reshot`, { shotId, instruction }),

	/** 旁白重录（异步执行） */
	retts: (base, runId, shotId, instruction, voice) =>
		request(base, "POST", `/api/runs/${encodeURIComponent(runId)}/retts`, {
			shotId,
			instruction,
			...(voice ? { voice } : {}),
		}),

	/** 按每镜勾选的版本组合出片（同步，限次） */
	compose: (base, runId, selections) =>
		request(base, "POST", `/api/runs/${encodeURIComponent(runId)}/compose`, { selections }),

	/** 每镜可用版本清单 */
	versions: (base, runId) => request(base, "GET", `/api/runs/${encodeURIComponent(runId)}/versions`),

	/** 重新导出（可指定画幅，异步执行） */
	reexport: (base, runId, aspectRatio) =>
		request(base, "POST", `/api/runs/${encodeURIComponent(runId)}/reexport`, {
			...(aspectRatio ? { aspectRatio } : {}),
		}),

	/** 设计图出图自审（step-3.7 视觉比对） */
	designReview: (base, runId, entityIds) =>
		request(base, "POST", `/api/runs/${encodeURIComponent(runId)}/design/review`, {
			...(entityIds ? { entityIds } : {}),
		}),

	/** 关键帧出图自审 */
	keyframeReview: (base, runId, shotIds) =>
		request(base, "POST", `/api/runs/${encodeURIComponent(runId)}/keyframes/review`, {
			...(shotIds ? { shotIds } : {}),
		}),

	/** 制片主任观察（B2 只读：产出建议，不执行） */
	kitchenObserve: (base, runId) =>
		request(base, "POST", `/api/runs/${encodeURIComponent(runId)}/kitchen/observe`, {}),

	/** 制片主任建议落执行（经 L2 守卫） */
	kitchenApply: (base, runId, obsId, suggestionId) =>
		request(base, "POST", `/api/runs/${encodeURIComponent(runId)}/kitchen/apply`, { obsId, suggestionId }),

	/** 导演优先级契约（B4 方向 1） */
	directorPriority: (base, runId, instruction) =>
		request(base, "POST", `/api/runs/${encodeURIComponent(runId)}/director/priority`, instruction),

	/** B5 A/B 度量：配额利用率 / 吞吐 / P95 / 浪费率 / 被拒率 */
	metrics: (base, runId) => request(base, "GET", `/api/runs/${encodeURIComponent(runId)}/metrics`),

	/** 预算告警台账（配额不足时产生） */
	budgetAlerts: (base, runId) => request(base, "GET", `/api/runs/${encodeURIComponent(runId)}/budget-alerts`),

	/** pre-flight 成本预估（可选端点，失败不影响主流程） */
	async estimate(base, shotCount, clipDurationSec) {
		try {
			return await request(base, "POST", "/api/pricing/estimate", { shotCount, clipDurationSec });
		} catch {
			return null;
		}
	},
};
