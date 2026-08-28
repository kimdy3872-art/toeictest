#!/usr/bin/env bash
# 템플릿/JS 에서 사용한 Tailwind 클래스만 골라 static/css/tailwind.css 로 컴파일한다.
# templates/*.html 또는 static/js/*.js 의 클래스를 바꾼 뒤에만 다시 실행하면 된다.
# (앱 실행 자체에는 불필요 — 이미 컴파일된 CSS 가 static/css/tailwind.css 에 있음)
set -e
cd "$(dirname "$0")"
npx -y tailwindcss@3.4.17 -c tailwind.config.js -i tailwind.input.css -o static/css/tailwind.css --minify
echo "-> static/css/tailwind.css 재생성 완료"
