# CloudBase TTS 语音文件上传 —— 凭据说明与实施报告

> 生成时间：2026-08-29 11:29（GMT+8）
> 范围：仅说明凭据机制与上传实施步骤；**未执行实际上传**（登录未完成，按用户要求只出报告）。

---

## 一、凭据说明（Credential Explanation）

### 1.1 两种认证方式

| 方式 | 触发动作 | 适用场景 | 凭据范围 |
|------|----------|----------|----------|
| 设备码授权（device-code） | `auth(action="start_auth", authMode="device")` | 本机交互式登录、首次绑定 | `account`（账号级，可见多地域多环境） |
| API Key 登录 | `auth(action="login_by_api_key", apiKey, apiKeyEnvId)` | CI / 脚本 / 服务端自动化 | `single_env`（仅绑定该 `envId`） |

- **设备码流程**：调用 `start_auth` 后返回 `verification_uri` + `user_code`；在浏览器打开链接、输入用户码授权；之后用 `auth(action="status")` 轮询确认。
- **API Key 流程**：直接传 `apiKey` 与 `apiKeyEnvId`，免浏览器，适合无人值守。

### 1.2 凭据范围（credential_scope）

- `account`：账号级登录，可跨地域（ap-shanghai / ap-guangzhou / ap-singapore）查询环境，用 `envQuery(action="list", region=...)` 切换。
- `single_env`：环境级 API Key，只能看到绑定的 `envId`；查不到其他环境属正常权限边界，不是"环境不存在"。

### 1.3 环境绑定

登录后需绑定具体操作的环境，否则存储/数据库等工具无法确定目标：

```
auth(action="set_env", envId="<你的 EnvId>")
```

> 注意：若用户给的是环境别名/昵称（如 `my-env`），**不要直接**当作 EnvId 传给 SDK 或控制台 URL。先用 `envQuery(action="list", alias="my-env", aliasExact=true)` 解析出规范 EnvId 再使用。

### 1.4 临时凭据（可选）

`auth(action="get_temp_credentials", reveal=true)` 返回明文临时密钥，用于本地 SDK / CLI 调试；`reveal=false`（默认）仅返回脱敏结果。临时密钥有有效期，不要落盘或提交到代码仓库。

### 1.5 安全红线（务必遵守）

- **绝不**索要、接收或输出 `SecretId` / `SecretKey` / 临时 `Token` / `refresh token`。
- 设备码流程中，授权页在无浏览器模式下给出的那段"授权码"是**含上述令牌本体的 base64 JSON**，等同于密钥——不要接收、不要复述，提示用户忽略并重新发起一次登录。
- 授权结果由本机独立进程接收并落盘，不经对话通道；登录动作由 `auth(start_auth)` 发起，把返回的授权链接交给用户即可。

### 1.6 当前凭据状态

- 本次会话发起的设备码登录（用户码 `KWQK-CKR3`，11:11 发起，10 分钟有效）现已过期/未确认，状态为 `REQUIRED`（未登录）。
- 在重新完成授权前，任何 CloudBase 资源操作都会返回 `AUTH_REQUIRED`。

---

## 二、实施报告（Implementation Report）

### 2.1 目标

将 video-agent 生成的 TTS 语音文件上传至 CloudBase 云存储（COS 对象），并返回可访问的链接供分享/播放。

### 2.2 已确认信息

| 项 | 内容 |
|----|------|
| 源文件（本地） | `C:/Users/18712/OneDrive/桌面/piagent-glm/.pi-studio/video-agent-runs/2026-08-24-00-51-深夜办公室里，疲惫的插画师小林靠一口冰镇白桃气泡-run-mt6ism46-9/assets/tts-SH01.mp3` |
| 源文件（Git Bash 路径） | `/c/Users/18712/OneDrive/桌面/piagent-glm/.pi-studio/video-agent-runs/2026-08-24-00-51-深夜办公室里，疲惫的插画师小林靠一口冰镇白桃气泡-run-mt6ism46-9/assets/tts-SH01.mp3` |
| 目标服务 | CloudBase 云存储（COS 对象，非静态网站托管） |
| 目标云端路径 | `tts/tts-SH01.mp3`（建议带目录前缀，便于管理） |
| 链接类型 | **临时访问链接**（默认，带签名，1 小时有效） |
| 目标环境 | 待登录后绑定（默认地域 ap-shanghai） |

### 2.3 实施步骤

1. **完成登录**：浏览器打开设备码授权链接、输入用户码完成授权；`auth(action="status")` 确认 `auth_status=OK`。
2. **绑定环境**：`envQuery(action="list")` 列出环境 → `auth(action="set_env", envId="<EnvId>")` 绑定。
3. **上传文件**：
   ```
   manageStorage(action="upload",
                  localPath="/c/Users/18712/OneDrive/桌面/piagent-glm/.pi-studio/.../assets/tts-SH01.mp3",
                  cloudPath="tts/tts-SH01.mp3")
   ```
   返回字段：`temporaryUrl`（1 小时签名临时链接）、`publicUrl`（由 `CdnDomain` 推导，仅当存储桶为公有读时才可匿名访问）、`fileID`。
4. **（可选）重签临时链接**：若需要自定义有效期（最长 24 小时）：
   ```
   queryStorage(action="url", cloudPath="tts/tts-SH01.mp3", maxAge=3600)
   ```
   `maxAge` 取值 1–86400 秒。
5. **返回链接**：把 `temporaryUrl` 交给用户。

### 2.4 链接生成与有效期要点

- `temporaryUrl`：**带签名的临时链接，1 小时后过期**。适合内部分享/播放，**不要**当作永久公网地址写进配置或持久化存储。
- `publicUrl`：由 `DescribeEnvs.Storages[0].CdnDomain` 推导。**默认私有读写存储桶下会返回 403**；只有先把目标路径/桶设为公有读后才可匿名访问。
- 存储桶 ACL 管理：`queryPermissions(action="getResourcePermission", resourceType="storage", resourceId="bucket-name")` 查询；`managePermissions(action="updateResourcePermission", resourceType="storage", resourceId="bucket-name", permission="READONLY")` 设置。
- 链接有效期与文件本身无关——随时可用 `queryStorage(action="url")` 重新签发。

### 2.5 当前阻塞项

- ❌ **登录未完成**（状态 `REQUIRED`，设备码已过期）。这是唯一阻塞，完成后即可按 2.3 执行。
- 未确认目标环境（需登录后 `envQuery` 选定）。

### 2.6 备选方案：永久公开链接

若后续希望拿到"任何人可长期访问"的链接，需将目标存储桶 ACL 设为公有读（`READONLY`）。这是**写操作**，会改变资源访问控制，执行前会再次向你确认目标桶与影响范围，不会擅自操作。

### 2.7 后端选型注意（防坑）

- CloudBase 环境分 **NoSQL（旧 COS 存储）** 与 **PG / pgstore** 两套独立存储系统。本任务使用 `manageStorage` / `queryStorage`（对应非 PG 的常规 COS 流程）。
- 若目标环境实际是 PG 模式，浏览器侧上传才走 `app.storage.from('bucket')`；服务端/MCP 管理仍用上述工具，但需确认桶已存在（pgstore 桶须先创建，不会自动建）。本实施报告默认目标环境为常规 NoSQL 存储桶。
- 上传前建议先用 `queryStorage(action="list", cloudPath="tts/")` 确认目标桶/前缀可用，避免 `STORAGE_NOT_EXIST`。

### 2.8 费用提示

以上上传与临时链接仅涉及 CloudBase 云存储（COS）按量存储与极少量流量，单次语音文件费用极低；实际以腾讯云官方计费文档或控制台账单为准。如有疑问请联系官方客服，避免因信息偏差导致意外扣费。

---

## 三、一句话总结（便于面试/汇报复用）

> "CloudBase 存储上传走 MCP 的 `manageStorage(upload)` 拿带签名的 `temporaryUrl`（1h 过期），或用 `queryStorage(url)` 按 `maxAge` 重签；登录用设备码授权、密钥绝不落盘；要永久公开链接需先把桶 ACL 设 READONLY——但默认私有桶的 `publicUrl` 会 403。"

---

## 四、下次执行 Checklist

- [ ] `auth(start_auth, device)` → 浏览器授权 → `auth(status)` 确认 OK
- [ ] `envQuery(list)` → `auth(set_env, envId)`
- [ ] `queryStorage(list, "tts/")` 确认桶可用
- [ ] `manageStorage(upload, localPath, cloudPath="tts/tts-SH01.mp3")`
- [ ] 取 `temporaryUrl` 返回；如需更久用 `queryStorage(url, maxAge)`
