# TOEIC Full 모의고사 웹 앱

AGY(Antigravity CLI)로 생성된 토익 Full 모의고사 JSON을 기반으로, 실제 시험과 동일한
인터페이스로 응시·자동 채점·오답 노트를 제공하는 웹 앱입니다.

## 기술 스택
- 백엔드: FastAPI + Uvicorn
- 프론트: HTML5 + Tailwind CSS(사전 컴파일 정적 파일) + Vanilla JS
- 데이터: `./data/*.json` 직접 파싱 (DB 불필요)
- LC 음성: gTTS(Google Text-to-Speech)

> Tailwind는 런타임 CDN(JIT) 대신 **미리 컴파일된 `static/css/tailwind.css`** 를
> 정적으로 링크합니다. 런타임 JIT가 없어 메인 스레드 멈춤이 없고, 앱 실행에는
> 어떤 빌드 단계도 필요 없습니다(이미 컴파일된 CSS가 포함됨).

## 실행 방법
```bash
# 1) 가상환경 & 의존성
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

# 2) 서버 실행 (시작 시 없는 LC 음성을 자동 생성)
uvicorn main:app --reload
# 또는  python main.py
```
브라우저에서 http://127.0.0.1:8000 접속.

### LC 음성 처리
서버는 **시작할 때 `data/`의 모든 회차를 스캔해 없는 MP3만 자동 생성**합니다
(이미 있으면 즉시 건너뜀 → 재시작은 대개 빠름). gTTS는 인터넷이 필요하며,
실패해도 서버는 정상 기동됩니다.

수동으로 미리/다시 만들려면:
```bash
python generate_audio.py          # 없는 파일만 생성
python generate_audio.py --force  # 전부 재생성
```
- 화자 억양(US/UK/AU)을 gTTS `tld`로 반영합니다. Part 3/4 는 세트의 첫 화자
  억양(US=us, UK=co.uk, AU=com.au)을 대표로 사용합니다. 억양이 바뀌면 `--force`로
  재생성하세요.

### Part 1 이미지 (무료)
Part 1 사진을 **Pollinations.ai**(무료·키 불필요)로 정답 장면 묘사에 맞춰 생성합니다.
서버 시작 시 없는 것만 자동 생성되며, 수동으로도 가능합니다:
```bash
python generate_images.py          # 없는 것만 생성 (static/images/{id}.jpg)
python generate_images.py --force  # 전부 재생성
```
이미지가 없으면 응시 화면은 사진 설명 텍스트로 폴백합니다.

자동 생성 제어 환경변수:
| 변수 | 기본 | 설명 |
|---|---|---|
| `TOEIC_AUTO_AUDIO` | `1` | `0`/`false`/`no`/`off` 로 LC 음성 자동 생성 끄기 |
| `TOEIC_AUDIO_LANG` | `en` | gTTS 언어 코드 |
| `TOEIC_AUTO_IMAGE` | `1` | `0`/`false`/`no`/`off` 로 Part 1 이미지 자동 생성 끄기 |

```bash
# 자동 생성 끄고 실행 (오프라인 등)
TOEIC_AUTO_AUDIO=0 TOEIC_AUTO_IMAGE=0 uvicorn main:app --reload
```

## 회차 추가
- `data/` 폴더에 `toeic_vol_2.json` 등 같은 스키마의 파일을 넣습니다.
- `exam_metadata.session` 값 또는 파일명 숫자로 회차를 인식합니다.
- 서버 재시작(또는 `POST /api/reload`) 후 헤더의 회차 선택 드롭다운에 노출됩니다.
- 음성은 **서버 재시작 시 새 회차 것만 자동 생성**됩니다(별도 명령 불필요).

## 주요 파일
| 파일 | 설명 |
|---|---|
| `main.py` | FastAPI 서버, JSON 파서, 채점 로직, API 라우트 |
| `generate_audio.py` | LC `audio_script` → gTTS MP3 (`static/audio/{id}.mp3`) |
| `templates/index.html` | 응시 메인 (헤더/타이머/OMR/파트 탭) |
| `templates/result.html` | 성적표 & 오답 노트 |
| `static/js/app.js` | 렌더링·타이머·OMR 마킹·제출 |
| `static/js/result.js` | 점수/파트별 통계/해설 렌더링 |
| `static/css/tailwind.css` | 사전 컴파일된 Tailwind (정적 링크) |
| `build_css.sh`, `tailwind.config.js`, `tailwind.input.css` | CSS 재빌드용(선택) |

## API
- `GET  /api/exams` — 회차 목록
- `GET  /api/exam/{session}` — 응시용 데이터 (정답·해설 제외)
- `POST /api/submit` — 답안 채점 → 결과 리포트 JSON
- `POST /api/reload` — data 폴더 재스캔

## 스타일(Tailwind) 재빌드 — 선택
`templates/*.html` 또는 `static/js/*.js` 에서 **새 Tailwind 클래스를 추가/변경한 경우에만**
CSS를 다시 컴파일합니다(Node 필요). 평상시 실행에는 불필요합니다.
```bash
./build_css.sh          # 또는
npx -y tailwindcss@3.4.17 -c tailwind.config.js -i tailwind.input.css -o static/css/tailwind.css --minify
```

## 채점 기준
- LC(Part 1~4) / RC(Part 5~7) 정답 비율을 각각 495점 만점으로 근사 환산(5점 단위).
- 실제 ETS 환산표는 비선형이며 회차별 문항 수가 가변적이므로 근사치입니다.

## 참고
- 정답/해설은 응시 페이로드에 포함되지 않고 서버에서만 채점합니다.
- 오디오 파일이 없으면 응시 화면에 안내가 뜨며, `generate_audio.py`로 생성하면 됩니다.
- Tailwind와 gTTS는 인터넷 연결이 필요합니다.
