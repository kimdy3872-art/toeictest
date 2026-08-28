#!/usr/bin/env bash
# TOEIC 모의고사 앱 실행 런처
#   - venv 없으면 자동 생성 + 의존성 설치
#   - 이전 인스턴스가 있으면 종료 후 재시작
#   - 서버 기동 후 브라우저 자동 오픈
# 터미널에서  `toeictest`  (alias) 또는  ./run.sh  로 실행.
set -euo pipefail

DIR="/Users/dykim/Documents/DAProj/toeictest"
HOST="127.0.0.1"
PORT="8000"
URL="http://${HOST}:${PORT}"

cd "$DIR"

# 1) venv 준비
if [ ! -x "venv/bin/uvicorn" ]; then
  echo "[setup] 가상환경 생성 및 의존성 설치 중… (최초 1회)"
  python3 -m venv venv
  ./venv/bin/pip install -q --upgrade pip
  ./venv/bin/pip install -q -r requirements.txt
fi

# 2) 같은 포트의 이전 인스턴스 종료
pkill -f "uvicorn main:app --host ${HOST} --port ${PORT}" 2>/dev/null || true
sleep 0.5

# 3) 서버 기동 후 브라우저 오픈
echo "[run] TOEIC 모의고사 서버 시작 → ${URL}  (종료: Ctrl+C)"
( sleep 2; open "${URL}" >/dev/null 2>&1 || true ) &

exec ./venv/bin/uvicorn main:app --host "${HOST}" --port "${PORT}"
