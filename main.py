"""
TOEIC Full 모의고사 웹 앱 - FastAPI 백엔드

- ./data 폴더의 회차별 JSON(toeic_vol_*.json)을 파싱하여 로드
- 응시용 데이터 제공 API (정답/해설은 제외)
- 제출 시 서버 사이드 자동 채점 + 결과 리포트 데이터 반환
- static/audio 의 gTTS MP3 서빙 (generate_audio.py 로 사전 생성)

실행:
    pip install -r requirements.txt
    python generate_audio.py        # (선택) LC 음성 사전 생성
    uvicorn main:app --reload
"""
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "static"
TEMPLATE_DIR = BASE_DIR / "templates"
AUDIO_DIR = STATIC_DIR / "audio"

app = FastAPI(title="TOEIC Mock Test")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATE_DIR))

# --------------------------------------------------------------------------- #
# 파트 메타데이터
# --------------------------------------------------------------------------- #
PART_LABELS = {
    1: "Part 1 · 사진 묘사",
    2: "Part 2 · 응답",
    3: "Part 3 · 대화",
    4: "Part 4 · 설명문",
    5: "Part 5 · 단문 공란",
    6: "Part 6 · 장문 공란",
    7: "Part 7 · 독해",
}
LC_PARTS = (1, 2, 3, 4)


# --------------------------------------------------------------------------- #
# 유틸
# --------------------------------------------------------------------------- #
def _qnum(qid: str, fallback: int) -> int:
    """문항 id( 예: 'LC3-32', 'RC5-101', '147' )의 끝 숫자를 문제 번호로 사용."""
    if qid is not None:
        m = re.search(r"(\d+)\s*$", str(qid))
        if m:
            return int(m.group(1))
    return fallback


def _first(raw: Dict[str, Any], *keys: str) -> Any:
    """여러 후보 키 중 처음으로 값이 있는 것을 반환.

    회차마다 생성 스키마가 달라(예: options/choices, answer/correctAnswer,
    question/questionText/text, id/no/number/questionNumber) 필드명이 제각각이라
    로더에서 별칭을 모두 흡수한다.
    """
    for k in keys:
        if k in raw and raw[k] not in (None, "", {}, []):
            return raw[k]
    return None


def _passage_content(s: Dict[str, Any]) -> Optional[str]:
    """Part 6/7 지문 본문을 회차별 다양한 필드에서 추출.

    content | text | passages | texts 를 허용하며, passages/texts 가
    리스트(문자열 또는 {type,content}/{content} dict 혼재)여도 이어붙인다.
    """
    val = _first(s, "content", "text", "passages", "texts")
    if val is None:
        return None
    if isinstance(val, str):
        return val
    if isinstance(val, list):
        parts: List[str] = []
        for item in val:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                label = item.get("type") or item.get("title")
                body = item.get("content") or item.get("text") or ""
                parts.append(f"[{label}]\n{body}" if label else str(body))
            else:
                parts.append(str(item))
        return "\n\n".join(p for p in parts if p)
    return str(val)


def _load_json(path: Path) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# --------------------------------------------------------------------------- #
# 정규화: 원본 JSON -> 내부 통합 구조
# --------------------------------------------------------------------------- #
def normalize_exam(data: Dict[str, Any]) -> Dict[str, Any]:
    """회차 JSON을 렌더링/채점에 공통으로 쓰는 평탄화 구조로 변환."""
    meta = data.get("exam_metadata", {})
    lc = data.get("lc", {}) or {}
    rc = data.get("rc", {}) or {}

    parts: List[Dict[str, Any]] = []
    counter = {"n": 0}

    def next_fallback() -> int:
        counter["n"] += 1
        return counter["n"]

    def make_q(section: str, part: int, raw: Dict[str, Any]) -> Dict[str, Any]:
        # 회차별 필드명 별칭 흡수
        qid = _first(raw, "id", "no", "number", "question_number", "questionNumber")
        # 문제 번호는 등장 순서(Part1→7)대로 1..200 순번으로 부여한다.
        # 회차마다 id 체계가 제각각(LC3-01-1 처럼 끝자리가 소문항 인덱스이거나
        # 아예 없음)이라, id 끝숫자에 의존하면 번호가 겹치거나 어긋난다.
        return {
            "qnum": next_fallback(),
            "id": "" if qid is None else str(qid),
            "part": part,
            "section": section,
            "question": _first(raw, "question", "questionText", "text"),
            "options": _first(raw, "options", "choices") or {},
            "answer": _first(raw, "answer", "correctAnswer", "correct_answer"),
            "explanation": raw.get("explanation"),
            "translation": raw.get("translation"),
            "category": raw.get("category"),
            "key_vocabulary": raw.get("key_vocabulary", []),
        }

    # ---- LC ----
    # Part 1: 사진 묘사 (문항 = 오디오, 옵션 텍스트는 표시하지 않음)
    p1_blocks = []
    for item in lc.get("part1", []) or []:
        q = make_q("lc", 1, item)
        p1_blocks.append({
            "kind": "lc-image",
            "part": 1,
            "section": "lc",
            "audio_id": item.get("id"),
            "audio_script": item.get("audio_script"),
            "image_description": item.get("image_description"),
            "questions": [q],
        })
    if p1_blocks:
        parts.append({"part": 1, "section": "lc",
                      "label": PART_LABELS[1], "blocks": p1_blocks})

    # Part 2: 응답 (옵션 A~C, 텍스트 미표시)
    p2_blocks = []
    for item in lc.get("part2", []) or []:
        q = make_q("lc", 2, item)
        p2_blocks.append({
            "kind": "lc-response",
            "part": 2,
            "section": "lc",
            "audio_id": item.get("id"),
            "audio_script": item.get("audio_script"),
            "questions": [q],
        })
    if p2_blocks:
        parts.append({"part": 2, "section": "lc",
                      "label": PART_LABELS[2], "blocks": p2_blocks})

    # Part 3 / Part 4: 세트형 (오디오 1 + 문항 여러 개)
    for part in (3, 4):
        blocks = []
        for s in lc.get(f"part{part}", []) or []:
            qs = [make_q("lc", part, q) for q in s.get("questions", []) or []]
            blocks.append({
                "kind": "lc-set",
                "part": part,
                "section": "lc",
                # 회차마다 키가 set_id/passage_id 로 다를 수 있어 모두 허용
                "audio_id": s.get("set_id") or s.get("passage_id"),
                "audio_script": s.get("audio_script"),
                "context_type": s.get("context_type"),
                "speakers": s.get("speakers", []),
                "questions": qs,
            })
        if blocks:
            parts.append({"part": part, "section": "lc",
                          "label": PART_LABELS[part], "blocks": blocks})

    # ---- RC ----
    # Part 5: 단문 공란 (개별 문항)
    p5_blocks = []
    for item in rc.get("part5", []) or []:
        q = make_q("rc", 5, item)
        p5_blocks.append({
            "kind": "rc-single",
            "part": 5,
            "section": "rc",
            "questions": [q],
        })
    if p5_blocks:
        parts.append({"part": 5, "section": "rc",
                      "label": PART_LABELS[5], "blocks": p5_blocks})

    # Part 6 / Part 7: 지문형
    for part in (6, 7):
        blocks = []
        for s in rc.get(f"part{part}", []) or []:
            qs = [make_q("rc", part, q) for q in s.get("questions", []) or []]
            blocks.append({
                "kind": "rc-passage",
                "part": part,
                "section": "rc",
                "context_type": _first(s, "context_type", "passage_type",
                                       "format", "topic", "title"),
                "content": _passage_content(s),
                "questions": qs,
            })
        if blocks:
            parts.append({"part": part, "section": "rc",
                          "label": PART_LABELS[part], "blocks": blocks})

    return {
        "session": meta.get("session"),
        "title": meta.get("title", "TOEIC Practice Test"),
        "total_questions": meta.get("total_questions"),
        "parts": parts,
    }


def strip_answers(exam: Dict[str, Any]) -> Dict[str, Any]:
    """응시용 페이로드: 정답/해설 제거."""
    def clean_q(q: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "qnum": q["qnum"],
            "id": q["id"],
            "part": q["part"],
            "section": q["section"],
            "question": q["question"],
            "options": q["options"],
            "category": q.get("category"),
        }

    out = {
        "session": exam["session"],
        "title": exam["title"],
        "total_questions": exam["total_questions"],
        "parts": [],
    }
    for p in exam["parts"]:
        blocks = []
        for b in p["blocks"]:
            nb = dict(b)
            # 오디오 스크립트(대본)는 응시 중 노출 금지 — 채점 결과에서만 제공
            nb.pop("audio_script", None)
            nb["questions"] = [clean_q(q) for q in b["questions"]]
            blocks.append(nb)
        out["parts"].append({
            "part": p["part"], "section": p["section"],
            "label": p["label"], "blocks": blocks,
        })
    # 실제 응시 가능 문항 수
    out["question_count"] = sum(
        len(b["questions"]) for p in exam["parts"] for b in p["blocks"]
    )
    return out


# --------------------------------------------------------------------------- #
# 데이터 로더 (프로세스 시작 시 1회 + 필요 시 새로고침)
# --------------------------------------------------------------------------- #
_EXAMS: Dict[int, Dict[str, Any]] = {}


def load_all_exams() -> Dict[int, Dict[str, Any]]:
    """./data/*.json 를 모두 파싱하여 세션 번호 기준으로 로드."""
    exams: Dict[int, Dict[str, Any]] = {}
    if not DATA_DIR.exists():
        return exams
    for path in sorted(DATA_DIR.glob("*.json")):
        try:
            raw = _load_json(path)
        except (json.JSONDecodeError, OSError) as e:
            print(f"[load] 건너뜀 {path.name}: {e}")
            continue
        exam = normalize_exam(raw)
        session = exam.get("session")
        if session is None:
            # 파일명에서 회차 추출 (toeic_vol_1.json -> 1)
            m = re.search(r"(\d+)", path.stem)
            session = int(m.group(1)) if m else len(exams) + 1
            exam["session"] = session
        exam["_source_file"] = path.name
        exams[int(session)] = exam
    return exams


def _auto_generate_audio() -> None:
    """서버 시작 시 없는 LC 음성만 자동 생성.

    - 환경변수 TOEIC_AUTO_AUDIO 로 제어 (기본 켜짐; "0"/"false"/"no" 로 끔).
    - gTTS 는 네트워크 요청이라 오프라인/오류 시에도 서버 기동을 막지 않도록
      예외를 모두 흡수한다. 이미 있는 파일은 건너뛰므로 재시작은 대개 즉시 끝난다.
    """
    flag = os.getenv("TOEIC_AUTO_AUDIO", "1").strip().lower()
    if flag in ("0", "false", "no", "off"):
        print("[startup] 오디오 자동 생성 비활성화 (TOEIC_AUTO_AUDIO)")
        return
    try:
        from generate_audio import generate_all
    except Exception as e:  # import 실패해도 서버는 떠야 함
        print(f"[startup] 오디오 모듈 로드 실패, 건너뜀: {e}")
        return
    try:
        lang = os.getenv("TOEIC_AUDIO_LANG", "en")
        print("[startup] LC 음성 확인/생성 중… (없는 파일만)")
        s = generate_all(lang=lang, quiet=True)
        print(f"[startup] 오디오 결과 - 대상 {s['total']} / 신규 {s['made']} / "
              f"유지 {s['skipped']} / 실패 {s['failed']}")
        if s["failed"] > 0:
            print("[startup] 일부 음성 생성 실패(네트워크 등). "
                  "나중에 'python generate_audio.py' 로 재시도할 수 있습니다.")
    except Exception as e:
        print(f"[startup] 오디오 자동 생성 중 오류(무시하고 계속): {e}")


def _auto_generate_images() -> None:
    """서버 시작 시 없는 Part 1 이미지만 자동 생성 (Pollinations, 무료).

    - 환경변수 TOEIC_AUTO_IMAGE 로 제어 (기본 켜짐; "0"/"false"/"no" 로 끔).
    - 네트워크 오류 시에도 서버 기동을 막지 않는다.
    """
    flag = os.getenv("TOEIC_AUTO_IMAGE", "1").strip().lower()
    if flag in ("0", "false", "no", "off"):
        print("[startup] Part1 이미지 자동 생성 비활성화 (TOEIC_AUTO_IMAGE)")
        return
    try:
        from generate_images import generate_all_images
    except Exception as e:
        print(f"[startup] 이미지 모듈 로드 실패, 건너뜀: {e}")
        return
    try:
        print("[startup] Part1 이미지 확인/생성 중… (없는 것만)")
        s = generate_all_images(quiet=True)
        print(f"[startup] 이미지 결과 - 대상 {s['total']} / 신규 {s['made']} / "
              f"유지 {s['skipped']} / 실패 {s['failed']}")
        if s["failed"] > 0:
            print("[startup] 일부 이미지 생성 실패(네트워크 등). "
                  "나중에 'python generate_images.py' 로 재시도할 수 있습니다.")
    except Exception as e:
        print(f"[startup] 이미지 자동 생성 중 오류(무시하고 계속): {e}")


@app.on_event("startup")
def _startup() -> None:
    global _EXAMS
    _EXAMS = load_all_exams()
    print(f"[startup] 로드된 회차: {sorted(_EXAMS.keys())}")
    _auto_generate_audio()
    _auto_generate_images()


def get_exam(session: int) -> Dict[str, Any]:
    if session not in _EXAMS:
        raise HTTPException(status_code=404, detail=f"회차 {session} 없음")
    return _EXAMS[session]


# --------------------------------------------------------------------------- #
# 채점
# --------------------------------------------------------------------------- #
# ETS 스타일 환산표 (정답 개수 0~100 -> 환산 점수 5~495).
# 실제 시험지마다 미세하게 다르지만, 널리 통용되는 표준 근사표를 사용한다.
# 상단은 압축(몇 개 틀려도 감점 적음), 하단은 5점 바닥이 특징인 비선형 곡선.
LC_CONVERSION = [
    5, 5, 5, 5, 5, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75,
    80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130, 135, 140, 145, 150,
    155, 160, 165, 170, 175, 180, 185, 190, 195, 200, 205, 210, 215, 220,
    225, 230, 235, 240, 245, 250, 255, 260, 265, 270, 275, 280, 285, 290,
    295, 300, 305, 310, 315, 320, 325, 330, 335, 340, 350, 360, 370, 380,
    390, 400, 410, 420, 430, 440, 450, 455, 460, 465, 470, 475, 480, 485,
    490, 495, 495, 495, 495, 495, 495, 495, 495, 495,
]
RC_CONVERSION = [
    5, 5, 5, 5, 5, 5, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70,
    75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130, 135, 140, 145,
    150, 155, 160, 165, 170, 175, 180, 185, 190, 195, 200, 205, 210, 215,
    220, 225, 230, 235, 240, 245, 250, 255, 260, 265, 270, 275, 280, 285,
    290, 295, 300, 305, 310, 315, 320, 325, 330, 335, 340, 345, 355, 365,
    375, 385, 395, 405, 415, 425, 435, 445, 455, 460, 465, 470, 475, 480,
    485, 490, 495, 495, 495, 495, 495, 495, 495, 495,
]


def _scaled_score(correct: int, total: int, section: str) -> int:
    """정답 개수를 ETS 환산표로 변환. 섹션 문항 수가 100이 아니면
    100문항 기준으로 환산(raw = correct/total*100)한 뒤 표를 조회한다.
    section: 'lc' 또는 'rc'.
    """
    if total <= 0:
        return 0
    raw = int(round(correct / total * 100))
    raw = max(0, min(100, raw))
    table = LC_CONVERSION if section == "lc" else RC_CONVERSION
    return table[raw]


class SubmitPayload(BaseModel):
    session: int
    answers: Dict[str, Optional[str]] = {}   # {"32": "A", ...}


def grade(exam: Dict[str, Any], answers: Dict[str, Optional[str]]) -> Dict[str, Any]:
    # qnum -> 정답 문항 원본
    flat: Dict[int, Dict[str, Any]] = {}
    block_of: Dict[int, Dict[str, Any]] = {}
    for p in exam["parts"]:
        for b in p["blocks"]:
            for q in b["questions"]:
                flat[q["qnum"]] = q
                block_of[q["qnum"]] = b

    def norm(v: Optional[str]) -> Optional[str]:
        return v.strip().upper() if isinstance(v, str) and v.strip() else None

    ans_by_num: Dict[int, Optional[str]] = {}
    for k, v in (answers or {}).items():
        try:
            ans_by_num[int(k)] = norm(v)
        except (ValueError, TypeError):
            continue

    details: List[Dict[str, Any]] = []
    part_stat: Dict[int, Dict[str, int]] = {}

    for qnum in sorted(flat.keys()):
        q = flat[qnum]
        b = block_of[qnum]
        part = q["part"]
        correct_answer = norm(q.get("answer"))
        your = ans_by_num.get(qnum)
        is_correct = your is not None and your == correct_answer

        ps = part_stat.setdefault(part, {"correct": 0, "total": 0})
        ps["total"] += 1
        if is_correct:
            ps["correct"] += 1

        details.append({
            "qnum": qnum,
            "id": q["id"],
            "part": part,
            "section": q["section"],
            "question": q["question"],
            "options": q["options"],
            "your_answer": your,
            "correct_answer": correct_answer,
            "is_correct": is_correct,
            "answered": your is not None,
            "explanation": q.get("explanation"),
            "translation": q.get("translation"),
            "category": q.get("category"),
            "key_vocabulary": q.get("key_vocabulary", []),
            # 결과 화면 컨텍스트(오디오/지문/스크립트)
            "audio_id": b.get("audio_id"),
            "audio_script": b.get("audio_script"),
            "image_description": b.get("image_description"),
            "context_type": b.get("context_type"),
            "content": b.get("content"),
            "speakers": b.get("speakers", []),
        })

    lc_correct = sum(part_stat.get(p, {}).get("correct", 0) for p in LC_PARTS)
    lc_total = sum(part_stat.get(p, {}).get("total", 0) for p in LC_PARTS)
    rc_correct = sum(part_stat.get(p, {}).get("correct", 0) for p in (5, 6, 7))
    rc_total = sum(part_stat.get(p, {}).get("total", 0) for p in (5, 6, 7))

    lc_score = _scaled_score(lc_correct, lc_total, "lc")
    rc_score = _scaled_score(rc_correct, rc_total, "rc")

    parts_report = []
    for part in sorted(part_stat.keys()):
        ps = part_stat[part]
        acc = round(ps["correct"] / ps["total"] * 100) if ps["total"] else 0
        parts_report.append({
            "part": part,
            "label": PART_LABELS.get(part, f"Part {part}"),
            "section": "lc" if part in LC_PARTS else "rc",
            "correct": ps["correct"],
            "total": ps["total"],
            "accuracy": acc,
        })

    return {
        "session": exam["session"],
        "title": exam["title"],
        "lc": {"correct": lc_correct, "total": lc_total, "score": lc_score},
        "rc": {"correct": rc_correct, "total": rc_total, "score": rc_score},
        "total_score": lc_score + rc_score,
        "total_correct": lc_correct + rc_correct,
        "total_questions": lc_total + rc_total,
        "parts": parts_report,
        "details": details,
    }


# --------------------------------------------------------------------------- #
# 라우트
# --------------------------------------------------------------------------- #
def _asset_ver() -> int:
    """정적 자산(css/js) 최신 수정시각. 템플릿의 ?v= 캐시버스터로 사용해
    재빌드/수정 시 브라우저가 새 파일을 받도록 한다."""
    latest = 0.0
    for rel in ("css/tailwind.css", "css/dark.css", "js/app.js", "js/result.js"):
        try:
            latest = max(latest, (STATIC_DIR / rel).stat().st_mtime)
        except OSError:
            continue
    return int(latest)


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    if not _EXAMS:
        return HTMLResponse(
            "<h1>데이터가 없습니다</h1><p>./data 폴더에 toeic_vol_*.json 을 넣고 "
            "서버를 재시작하세요.</p>", status_code=200)
    session = sorted(_EXAMS.keys())[0]
    exam = _EXAMS[session]
    return templates.TemplateResponse("index.html", {
        "request": request,
        "session": session,
        "title": exam["title"],
        "sessions": sorted(_EXAMS.keys()),
        "ver": _asset_ver(),
    })


@app.get("/exam/{session}", response_class=HTMLResponse)
def exam_page(request: Request, session: int):
    exam = get_exam(session)
    return templates.TemplateResponse("index.html", {
        "request": request,
        "session": session,
        "title": exam["title"],
        "sessions": sorted(_EXAMS.keys()),
        "ver": _asset_ver(),
    })


@app.get("/result", response_class=HTMLResponse)
def result_page(request: Request):
    return templates.TemplateResponse("result.html", {
        "request": request,
        "ver": _asset_ver(),
    })


@app.get("/api/exams")
def api_exams():
    return {
        "exams": [
            {
                "session": s,
                "title": _EXAMS[s]["title"],
                "question_count": sum(
                    len(b["questions"])
                    for p in _EXAMS[s]["parts"] for b in p["blocks"]
                ),
            }
            for s in sorted(_EXAMS.keys())
        ]
    }


@app.get("/api/exam/{session}")
def api_exam(session: int):
    exam = get_exam(session)
    return JSONResponse(strip_answers(exam))


@app.post("/api/submit")
def api_submit(payload: SubmitPayload):
    exam = get_exam(payload.session)
    return JSONResponse(grade(exam, payload.answers))


@app.post("/api/reload")
def api_reload():
    """data 폴더를 다시 스캔 (개발 편의)."""
    global _EXAMS
    _EXAMS = load_all_exams()
    return {"loaded_sessions": sorted(_EXAMS.keys())}


if __name__ == "__main__":
    import uvicorn
    _EXAMS = load_all_exams()
    print(f"[main] 로드된 회차: {sorted(_EXAMS.keys())}")
    uvicorn.run(app, host="127.0.0.1", port=8000)
