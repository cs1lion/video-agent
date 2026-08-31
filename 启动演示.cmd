@echo off
chcp 65001 >nul
title video-agent 演示环境

REM ============================================================
REM video-agent 演示环境一键启动（面试/演示用）
REM   API   : http://127.0.0.1:8790  （UI 代理硬指向 8790，不可换端口）
REM   UI    : http://localhost:5200
REM   含自动质检-修复闭环（VIDEO_AGENT_AUTO_REPAIR=1）
REM   不限每日秒数（VIDEO_AGENT_QUOTA_DAILY_SEC=0，免费期按 RPM 限流）
REM ============================================================

REM ---- 0) 端口预检：8790 被占则拒绝启动（占用的多半是其他会话的旧码服务）----
netstat -ano | findstr /R /C:":8790[ ].*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [阻止启动] 8790 已被占用（可能是其他会话的旧码服务，UI 代理固定指向 8790）：
  netstat -ano | findstr /R /C:":8790[ ].*LISTENING"
  echo 请先 taskkill /PID ^<上面第三列PID^> /F 释放端口，再重新运行本脚本。
  echo.
  pause
  exit /b 1
)

REM ---- 1) API 服务（新窗口，保持打开）----
start "video-agent API (8790)" cmd /k "cd /d %~dp0pi\packages\video-agent-server && set PORT=8790&& set VIDEO_AGENT_QUOTA_DAILY_SEC=0&& set VIDEO_AGENT_AUTO_REPAIR=1&& npx tsx src/server.ts"

REM ---- 2) 前端工作台（新窗口，保持打开）----
start "video-agent UI (5200)" cmd /k "cd /d %~dp0pi\packages\video-agent-ui && npm run dev"

echo.
echo ==============================================
echo  API : http://127.0.0.1:8790/api/health   （就绪约 5-10 秒，可浏览器打开确认 {"ok":true}）
echo  UI  : http://localhost:5200              （Vite 就绪约 3-5 秒）
echo  动线 : 演示动线-面试官版-2026-08-31.md
echo ==============================================
echo 两个新窗口请保持打开；关闭即停止对应服务。
echo.
pause
