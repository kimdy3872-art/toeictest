"""
Part 1 이미지 사전 생성 스크립트 (Pollinations.ai - 무료, API 키 불필요)

./data/*.json 의 LC Part 1 문항에 대해, "정답 옵션의 영문 장면 묘사"를
프롬프트로 사용하여 사진을 생성하고 static/images/{id}.jpg 로 저장한다.
(정답이 곧 사진 장면이므로 실제 TOEIC 사진과 동일한 원리)

- 완전 무료 / 키 불필요 (https://pollinations.ai)
- 이미 있는 파일은 건너뜀 (--force 로 전부 재생성)
- 네트워크 오류 시에도 나머지는 계속 진행

사용:
    python generate_images.py            # 없는 것만 생성
    python generate_images.py --force    # 전부 재생성
"""
import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
import zlib
from pathlib import Path
from typing import Dict, Iterator, Tuple

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
IMAGE_DIR = BASE_DIR / "static" / "images"

POLLINATIONS = "https://image.pollinations.ai/prompt/"
STYLE = ("realistic candid photograph, everyday workplace or public setting, "
         "natural lighting, no text, no watermark")


def iter_part1_prompts(data: Dict) -> Iterator[Tuple[str, str]]:
    """(image_id, prompt) 를 Part 1 에서 추출.

    프롬프트 우선순위:
      1) image_prompt   - AGY가 생성하는 영문 이미지 전용 프롬프트(가장 정확)
      2) options[answer] - 정답 옵션 영문(정답이 곧 사진 장면)
      3) image_description - 마지막 폴백
    """
    for item in (data.get("lc", {}) or {}).get("part1", []) or []:
        iid = item.get("id")
        if not iid:
            continue
        options = item.get("options", {}) or {}
        answer = item.get("answer")
        scene = (item.get("image_prompt")
                 or options.get(answer)
                 or item.get("image_description") or "").strip()
        if not scene:
            continue
        yield iid, f"{scene} {STYLE}"


def safe_name(image_id: str) -> str:
    import re
    return re.sub(r"[^A-Za-z0-9._-]", "_", image_id)


def session_of(data: Dict, path: Path) -> str:
    """회차 번호(exam_metadata.session 또는 파일명 숫자). 회차별 하위 폴더 분리용."""
    import re
    s = (data.get("exam_metadata", {}) or {}).get("session")
    if s is not None:
        return str(s)
    m = re.search(r"(\d+)", path.stem)
    return m.group(1) if m else "0"


def build_url(prompt: str, seed: int) -> str:
    enc = urllib.parse.quote(prompt, safe="")
    return (f"{POLLINATIONS}{enc}"
            f"?width=768&height=512&nologo=true&model=flux&seed={seed}")


def generate_all_images(force: bool = False, quiet: bool = False,
                        timeout: int = 60) -> Dict[str, int]:
    """Part 1 이미지를 생성/다운로드. 통계 dict 반환."""
    stats = {"total": 0, "made": 0, "skipped": 0, "failed": 0}

    def log(msg: str) -> None:
        if not quiet:
            print(msg)

    if not DATA_DIR.exists():
        log(f"데이터 폴더가 없습니다: {DATA_DIR}")
        return stats

    IMAGE_DIR.mkdir(parents=True, exist_ok=True)

    for path in sorted(DATA_DIR.glob("*.json")):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            log(f"[skip] {path.name}: {e}")
            continue

        session = session_of(data, path)
        session_dir = IMAGE_DIR / session
        session_dir.mkdir(parents=True, exist_ok=True)
        printed = False
        for image_id, prompt in iter_part1_prompts(data):
            stats["total"] += 1
            out = session_dir / f"{safe_name(image_id)}.jpg"
            if out.exists() and not force:
                stats["skipped"] += 1
                continue
            if not printed:
                log(f"\n=== {path.name} ===")
                printed = True
            # id 기반 고정 시드 -> 재실행 시 동일 이미지(재현성)
            seed = zlib.crc32(image_id.encode("utf-8")) % 1_000_000
            url = build_url(prompt, seed)
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "toeictest/1.0"})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    body = r.read()
                if not body or len(body) < 1000:
                    raise ValueError(f"응답이 너무 작음 ({len(body)}B)")
                out.write_bytes(body)
                stats["made"] += 1
                log(f"  [gen ] {out.name}  ({len(body)//1024}KB)")
                time.sleep(0.5)   # 서비스 배려
            except Exception as e:
                stats["failed"] += 1
                log(f"  [fail] {image_id}: {e}")

    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Part 1 이미지 -> Pollinations")
    parser.add_argument("--force", action="store_true", help="기존 파일도 재생성")
    args = parser.parse_args()
    s = generate_all_images(force=args.force)
    print(f"\n완료: 대상 {s['total']} / 생성 {s['made']} / "
          f"유지 {s['skipped']} / 실패 {s['failed']}")
    print(f"저장 위치: {IMAGE_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
