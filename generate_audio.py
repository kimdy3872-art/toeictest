"""
LC 오디오 사전 생성 스크립트 (gTTS)

./data/*.json 의 LC(Part 1~4) audio_script 텍스트를 감지하여
gTTS 로 MP3 를 합성하고 static/audio/{id}.mp3 로 저장한다.

- Part 1 / Part 2 : 문항 id 기준     (예: LC1-01.mp3, LC2-07.mp3)
- Part 3 / Part 4 : set_id 기준       (예: LC3-SET01.mp3)

사용:
    pip install gtts
    python generate_audio.py            # 없는 파일만 생성
    python generate_audio.py --force    # 전부 재생성
    python generate_audio.py --lang en  # 언어 지정(기본 en)
"""
import argparse
import json
import re
import sys
from pathlib import Path
from typing import Dict, Iterator, Tuple

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
AUDIO_DIR = BASE_DIR / "static" / "audio"

# "Speaker 1 (Female, US): " / "Speaker 2: " 형태의 화자 라벨 제거용
_SPEAKER_PREFIX = re.compile(r"Speaker\s*\d+\s*(\([^)]*\))?\s*:\s*", re.IGNORECASE)


def clean_script(text: str) -> str:
    """TTS 낭독에 불필요한 화자 라벨/여백을 정리."""
    if not text:
        return ""
    text = _SPEAKER_PREFIX.sub("", text)
    # 줄바꿈은 문장 사이 짧은 쉼으로
    text = re.sub(r"\s*\n\s*", ". ", text)
    text = re.sub(r"\s{2,}", " ", text).strip()
    return text


# 화자 억양 -> gTTS tld (Google TTS 도메인별 발음)
ACCENT_TLD = {
    "US": "us", "AU": "com.au", "UK": "co.uk", "GB": "co.uk",
    "CA": "ca", "IN": "co.in", "IE": "ie", "ZA": "co.za",
}
DEFAULT_TLD = "us"


def _tld_for_speakers(speakers: list) -> str:
    """세트의 대표 억양(첫 화자 기준)을 tld로 변환. gTTS는 단일 음성이므로
    한 파일에는 하나의 억양만 적용된다."""
    for sp in speakers or []:
        acc = (sp.get("accent") or "").strip().upper()
        if acc in ACCENT_TLD:
            return ACCENT_TLD[acc]
    return DEFAULT_TLD


def iter_lc_scripts(data: Dict) -> Iterator[Tuple[str, str, str]]:
    """(audio_id, script, tld) 쌍을 LC 전 파트에서 추출."""
    lc = data.get("lc", {}) or {}

    # Part 1/2 는 화자 정보가 없어 기본 억양(US)
    for item in lc.get("part1", []) or []:
        aid, script = item.get("id"), item.get("audio_script")
        if aid and script:
            yield aid, script, DEFAULT_TLD

    for item in lc.get("part2", []) or []:
        aid, script = item.get("id"), item.get("audio_script")
        if aid and script:
            yield aid, script, DEFAULT_TLD

    # Part 3/4 는 세트의 첫 화자 억양을 대표로 사용
    # (회차마다 세트 키가 set_id / passage_id 로 다를 수 있어 모두 허용)
    for part in ("part3", "part4"):
        for s in lc.get(part, []) or []:
            aid = s.get("set_id") or s.get("passage_id")
            script = s.get("audio_script")
            if aid and script:
                yield aid, script, _tld_for_speakers(s.get("speakers", []))


def safe_name(audio_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", audio_id)


def session_of(data: Dict, path: Path) -> str:
    """회차 번호를 exam_metadata.session 또는 파일명 숫자에서 구한다.
    회차별 하위 폴더로 자산을 분리해 파일명 충돌(회차 간 동일 id)을 막는다."""
    s = (data.get("exam_metadata", {}) or {}).get("session")
    if s is not None:
        return str(s)
    m = re.search(r"(\d+)", path.stem)
    return m.group(1) if m else "0"


def generate_all(force: bool = False, lang: str = "en", slow: bool = False,
                 quiet: bool = False) -> Dict[str, int]:
    """./data/*.json 의 LC 음성을 생성한다.

    - force=False 이면 이미 존재하는 MP3 는 건너뛴다(없는 것만 생성).
    - 서버 startup 훅과 CLI 양쪽에서 재사용한다.
    - 예외는 개별 문항 단위로 잡아, 일부 실패해도 나머지는 계속 진행한다.

    반환: {"total", "made", "skipped", "failed"} 통계 dict.
    """
    stats = {"total": 0, "made": 0, "skipped": 0, "failed": 0}

    def log(msg: str) -> None:
        if not quiet:
            print(msg)

    try:
        from gtts import gTTS
    except ImportError:
        log("gTTS 가 설치되어 있지 않습니다. 'pip install gtts' 후 실행하세요.")
        stats["failed"] = -1
        return stats

    if not DATA_DIR.exists():
        log(f"데이터 폴더가 없습니다: {DATA_DIR}")
        return stats

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    for path in sorted(DATA_DIR.glob("*.json")):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            log(f"[skip] {path.name}: {e}")
            continue

        session = session_of(data, path)
        session_dir = AUDIO_DIR / session
        session_dir.mkdir(parents=True, exist_ok=True)
        printed_header = False
        for audio_id, script, tld in iter_lc_scripts(data):
            stats["total"] += 1
            out = session_dir / f"{safe_name(audio_id)}.mp3"
            if out.exists() and not force:
                stats["skipped"] += 1
                continue
            text = clean_script(script)
            if not text:
                stats["failed"] += 1
                continue
            if not printed_header:
                log(f"\n=== {path.name} ===")
                printed_header = True
            try:
                gTTS(text=text, lang=lang, tld=tld, slow=slow).save(str(out))
                stats["made"] += 1
                log(f"  [gen ] {out.name}  ({tld})")
            except Exception as e:  # 네트워크/gTTS 오류 등
                stats["failed"] += 1
                log(f"  [fail] {audio_id}: {e}")

    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="LC audio_script -> gTTS MP3")
    parser.add_argument("--force", action="store_true", help="기존 파일도 재생성")
    parser.add_argument("--lang", default="en", help="gTTS 언어 코드 (기본 en)")
    parser.add_argument("--slow", action="store_true", help="느리게 낭독")
    args = parser.parse_args()

    s = generate_all(force=args.force, lang=args.lang, slow=args.slow)
    print(f"\n완료: 대상 {s['total']} / 생성 {s['made']} / "
          f"유지 {s['skipped']} / 실패 {s['failed']}")
    print(f"저장 위치: {AUDIO_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
