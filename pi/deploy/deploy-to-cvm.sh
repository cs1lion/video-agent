#!/usr/bin/env bash
# video-agent 云服务器部署脚本（Ubuntu 24.04，非 root，sudo 免密）
#
# 用法（在目标服务器上）：
#   bash deploy-to-cvm.sh <video-agent-src.tar.gz 路径>
# 例：
#   bash deploy-to-cvm.sh /tmp/video-agent-src.tar.gz
#
# 设计约束（针对 2核 / 1GB 内存小机型）：
#   1. UI 静态产物在**打包侧**已构建好，服务器不再跑 vite build（1GB 内存必 OOM）。
#   2. 先扩 2G swap 兜底 npm ci 峰值内存。
#   3. npm ci 用 --max-old-space-size 限制堆，避免触发系统 OOM killer。
#
# 产物：
#   /opt/video-agent           源码 + node_modules + UI dist
#   /etc/systemd/system/video-agent.service
#   http://<IP>:8080/           UI    |   /api/health → {"ok":true,...}

set -euo pipefail

TARBALL="${1:-}"
APP_DIR=/opt/video-agent
SERVICE_NAME=video-agent
PORT=8080
NODE_MAJOR=22
SWAP_FILE=/swapfile
SWAP_SIZE=2G

log() { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[deploy][FATAL]\033[0m %s\n' "$*" >&2; exit 1; }

[[ -n "$TARBALL" && -f "$TARBALL" ]] || die "用法: bash $0 <video-agent-src.tar.gz>"

# 非 root：统一走 sudo
if [[ "$(id -u)" -ne 0 ]]; then
  SUDO=sudo
  sudo -n true 2>/dev/null || die "当前用户无免密 sudo，请先配置"
else
  SUDO=
fi

# ------------------------------------------------------------------ 1. swap
if swapon --show | grep -q "$SWAP_FILE"; then
  log "swap 已存在: $(swapon --show | grep "$SWAP_FILE" | awk '{print $3}')"
else
  log "创建 ${SWAP_SIZE} swap（1GB 内存机型兜底 npm ci）..."
  $SUDO fallocate -l "$SWAP_SIZE" "$SWAP_FILE" \
    || $SUDO dd if=/dev/zero of="$SWAP_FILE" bs=1M count=2048
  $SUDO chmod 600 "$SWAP_FILE"
  $SUDO mkswap "$SWAP_FILE" >/dev/null
  $SUDO swapon "$SWAP_FILE"
  grep -q "$SWAP_FILE" /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" | $SUDO tee -a /etc/fstab >/dev/null
  log "swap 已启用: $(free -h | awk '/Swap/{print $2}')"
fi

# -------------------------------------------------------------- 2. 系统依赖
log "安装 ffmpeg（若已安装则跳过）..."
if ! command -v ffmpeg >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq ffmpeg ca-certificates curl git
else
  log "ffmpeg 已就绪: $(ffmpeg -version | head -1)"
fi
command -v ffmpeg >/dev/null || die "ffmpeg 安装失败（合成层 execFile 直接走 PATH，必须有）"

# -------------------------------------------------------------- 2b. 中文字体
# 字幕烧录硬依赖：导出 ASS FontName=Microsoft YaHei（Windows 字体名），服务器必须
# 装 fonts-noto-cjk 并用 fontconfig 别名把它映射到 Noto，否则中文字幕烧成方块。
# 幂等：已装则跳过 apt；alias 文件每次覆盖（内容稳定，无副作用）。
if ! fc-list :lang=zh 2>/dev/null | grep -q .; then
  log "安装中文字体 fonts-noto-cjk（首次部署必需，约 30s）..."
  $SUDO apt-get install -y -qq fonts-noto-cjk
fi
$SUDO tee /etc/fonts/conf.d/99-msyh-alias.conf >/dev/null <<'EOF'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <match target="pattern">
    <test name="family"><string>Microsoft YaHei</string></test>
    <edit name="family" mode="assign" binding="strong"><string>Noto Sans CJK SC</string></edit>
  </match>
</fontconfig>
EOF
$SUDO fc-cache -f >/dev/null 2>&1 || true
# 验证：fc-match Microsoft YaHei 应返回 Noto Sans CJK SC
fc-match 'Microsoft YaHei' 2>/dev/null | grep -q 'Noto Sans CJK' \
  || die "中文字体安装或 fontconfig 别名失败（fc-match 未命中 Noto）"
log "中文字体就绪：fc-match Microsoft YaHei → $(fc-match 'Microsoft YaHei' | cut -d: -f2)"

# ----------------------------------------------------------------- 3. Node
if command -v node >/dev/null 2>&1 \
   && [[ "$(node -v | sed 's/^v//' | cut -d. -f1)" -ge "$NODE_MAJOR" ]]; then
  log "Node 已就绪: $(node -v)"
else
  log "安装 Node $NODE_MAJOR（NodeSource）..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
  $SUDO apt-get install -y -qq nodejs
fi
command -v node >/dev/null || die "Node 安装失败"
[[ "$(node -v | sed 's/^v//' | cut -d. -f1)" -ge "$NODE_MAJOR" ]] \
  || die "Node 版本过低: $(node -v)，需要 >= ${NODE_MAJOR}"
log "node $(node -v) / npm $(npm -v)"

# 国内源加速（服务器在中国大陆，npmjs 直连常慢/超时）
if ! npm config get registry | grep -q npmmirror; then
  log "切换 npm registry → npmmirror（国内加速）"
  npm config set registry https://registry.npmmirror.com
fi

# ------------------------------------------------------------------ 4. 解包
log "解包到 $APP_DIR ..."
$SUDO rm -rf "$APP_DIR"
$SUDO mkdir -p "$APP_DIR"
$SUDO tar -xzf "$TARBALL" -C "$APP_DIR"
$SUDO chown -R "$(whoami):$(whoami)" "$APP_DIR"
[[ -f "$APP_DIR/package.json" ]] || die "解包内容异常：缺少 package.json"

# provider key：deploy/models.json → 运行期读取的 .pi-studio/models.json
mkdir -p "$APP_DIR/.pi-studio"
if [[ -f "$APP_DIR/deploy/models.json" ]]; then
  cp "$APP_DIR/deploy/models.json" "$APP_DIR/.pi-studio/models.json"
  chmod 600 "$APP_DIR/.pi-studio/models.json"
  log "models.json 已就位（权限 600）"
else
  log "警告：未找到 deploy/models.json，provider key 需自行写入 $APP_DIR/.pi-studio/models.json"
fi
mkdir -p "$APP_DIR/.pi-studio/video-agent-runs"

# ------------------------------------------------------------- 5. 依赖安装
cd "$APP_DIR"
log "npm ci（全 monorepo，小机型约 5-15 分钟）..."
export NODE_OPTIONS=--max-old-space-size=1024
npm ci --no-audit --no-fund 2>&1 | tail -20

# UI dist 由打包侧构建；此处仅做存在性校验
[[ -d "$APP_DIR/packages/video-agent-ui/dist" ]] \
  || die "UI dist 缺失：打包前需先 npm run build -w @earendil-works/pi-video-agent-ui"
log "UI dist 校验通过（$(find "$APP_DIR/packages/video-agent-ui/dist" -type f | wc -l) 个文件）"

# -------------------------------------------------------------- 6. systemd
log "写入 systemd 单元..."
$SUDO tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=video-agent (API + UI 同源)
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${APP_DIR}/packages/video-agent-server
Environment=PORT=${PORT}
Environment=NODE_ENV=production
Environment=VIDEO_AGENT_QUOTA_DAILY_SEC=0
Environment=VIDEO_AGENT_AUTO_REPAIR=1
Environment=NODE_OPTIONS=--max-old-space-size=768
# 台词音频托管（COS）——按需填入，留空则走本地落盘
# Environment=TCB_ENV_ID=
# Environment=TCB_SECRET_ID=
# Environment=TCB_SECRET_KEY=
ExecStart=/usr/bin/env npx tsx src/server.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now "$SERVICE_NAME"

# ------------------------------------------------------------ 7. 健康检查
log "等待服务启动（最多 60s）..."
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    log "健康检查通过（第 ${i}s）"
    curl -fsS "http://127.0.0.1:${PORT}/api/health"; echo
    log "部署完成 → http://<公网IP>:${PORT}/"
    log "查看日志: sudo journalctl -u ${SERVICE_NAME} -f"
    exit 0
  fi
  sleep 1
done

die "60s 内健康检查未通过。排查: sudo journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
