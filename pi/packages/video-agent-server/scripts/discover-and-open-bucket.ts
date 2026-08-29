/**
 * 一次性脚本：发现 CloudBase 环境的 COS 桶名/区域 → 设置桶 ACL 公有读 → 验证匿名读。
 * CAM 密钥从 .env.cloudbase 读（不入库）。
 */
import * as path from "node:path";
import * as url from "node:url";
import * as fs from "node:fs";

const serverRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const studioRoot = path.resolve(serverRoot, "..", "..", "..", "..");

// 手动解析 .env.cloudbase（不依赖 src 的 loadHostingConfig，保持脚本独立）
const envFile = fs.readFileSync(path.join(serverRoot, ".env.cloudbase"), "utf-8");
const env = Object.fromEntries(
	envFile
		.split(/\r?\n/)
		.filter((l) => l && !l.startsWith("#") && l.includes("="))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
		}),
);
const { TCB_ENV_ID: envId, TCB_SECRET_ID: secretId, TCB_SECRET_KEY: secretKey } = env;
if (!envId || !secretId || !secretKey) {
	console.error("missing TCB_ENV_ID/TCB_SECRET_ID/TCB_SECRET_KEY in .env.cloudbase");
	process.exit(1);
}

// 1. 发现桶名/区域（node-sdk getUploadMetadata 返回 COS PUT URL）
const tcb = (await import("@cloudbase/node-sdk")).default;
const app = tcb.init({ secretId, secretKey, secretVersion: undefined, env: envId } as never);
const meta = (await app.getUploadMetadata({ cloudPath: "video-agent/acl-probe/discover.txt" })) as unknown as Record<string, unknown>;
console.log("metadata keys:", JSON.stringify(meta).slice(0, 500));
const metaUrl = (meta.url ?? (meta.data as Record<string, unknown> | undefined)?.url ?? "") as string;
console.log("metadata url:", metaUrl.slice(0, 160));
const m = metaUrl.match(/https:\/\/([^\.]+)\.cos\.([^\.]+)\.myqcloud\.com/);
if (!m) {
	console.error("cannot parse COS url");
	process.exit(2);
}
const bucket = m[1]!;
const region = m[2]!;
console.log(`discovered bucket=${bucket} region=${region}`);

// 2. 读当前 ACL
const Cos = (await import("cos-nodejs-sdk-v5")).default;
const cos = new Cos({ SecretId: secretId, SecretKey: secretKey });
const getAcl = (): Promise<unknown> =>
	new Promise((resolve, reject) => cos.getBucketAcl({ Bucket: bucket, Region: region }, (err, data) => (err ? reject(err) : resolve(data))));
try {
	const acl = (await getAcl()) as { AccessControlList?: { Grant?: { Grantee?: { URI?: string }; Permission?: string }[] } };
	console.log("current ACL:", JSON.stringify(acl.AccessControlList?.Grant ?? acl));
} catch (e) {
	console.error("getBucketAcl failed:", String(e).slice(0, 300));
}

// 3. 设置公有读
const putAcl = (): Promise<unknown> =>
	new Promise((resolve, reject) =>
		cos.putBucketAcl({ Bucket: bucket, Region: region, ACL: "public-read" }, (err, data) => (err ? reject(err) : resolve(data))),
	);
try {
	await putAcl();
	console.log("putBucketAcl public-read: OK");
} catch (e) {
	console.error("putBucketAcl failed:", String(e).slice(0, 300));
	process.exit(3);
}

// 4. 验证：匿名 Range 读刚上传的探针对象
const pubUrl = `https://${envId}.tcb.qcloud.la/video-agent/probe-a2/tts-TEST.mp3`;
const res = await fetch(pubUrl, { headers: { Range: "bytes=0-255" } });
console.log("anonymous range after ACL:", res.status, res.headers.get("content-type"));
process.exit(res.status === 206 ? 0 : 4);
