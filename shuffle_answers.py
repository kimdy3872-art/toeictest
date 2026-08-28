"""회차 정답 셔플 스크립트.

각 문항의 보기(options) 순서를 무작위로 섞고 정답(answer)을 그에 맞게 갱신한다.
- 정답 '텍스트'는 그대로 유지되고, 그 텍스트가 놓이는 letter만 바뀐다(정답 보존).
- Part 1/2 는 보기를 오디오로 듣기 때문에 audio_script 도 함께 재구성한다.
  (Part 3/4 의 audio_script 는 대화문이라 건드리지 않는다.)
- 결정론적: --seed 로 재현 가능.

사용:
    python shuffle_answers.py data/toeic_vol_1.json            # 제자리 덮어쓰기
    python shuffle_answers.py data/toeic_vol_1.json --seed 42
"""
import argparse
import json
import random
import re
from typing import Dict, List, Tuple

LETTERS = ["A", "B", "C", "D", "E"]


def shuffle_options(options: Dict[str, str], answer: str,
                    rng: random.Random) -> Tuple[Dict[str, str], str, List[str]]:
    """options/answer 를 섞어 (새 options, 새 answer, 새 텍스트순서) 반환."""
    letters = sorted(options.keys())
    if not letters:
        return options, answer, []
    ans = (answer or "").strip().upper()
    correct_text = options.get(ans) if ans in options else None

    texts = [options[L] for L in letters]
    rng.shuffle(texts)

    new_options = {letters[i]: texts[i] for i in range(len(letters))}
    new_answer = answer
    if correct_text is not None:
        for L, t in new_options.items():
            if t == correct_text:
                new_answer = L
                break
    return new_options, new_answer, texts


def rebuild_part1_script(new_options: Dict[str, str]) -> str:
    """Part 1: '(A) .. (B) .. (C) .. (D) ..' 형태로 재구성."""
    return " ".join(f"({L}) {new_options[L]}" for L in sorted(new_options))


def rebuild_part2_script(old_script: str, new_options: Dict[str, str]) -> str:
    """Part 2: 'Question: <stem> (A) .. (B) .. (C) ..' 에서 stem 유지, 보기만 교체."""
    stem = old_script or ""
    m = re.search(r"\(A\)", stem)
    if m:
        stem = stem[:m.start()].rstrip()
    opts = " ".join(f"({L}) {new_options[L]}" for L in sorted(new_options))
    return f"{stem} {opts}".strip()


def process(data: Dict, rng: random.Random) -> Dict[str, int]:
    stats = {"shuffled": 0, "part1_audio": 0, "part2_audio": 0, "unchanged": 0}
    lc = data.get("lc", {}) or {}
    rc = data.get("rc", {}) or {}

    def do_q(q: Dict) -> None:
        opts = q.get("options") or {}
        if not opts:
            return
        new_opts, new_ans, _ = shuffle_options(opts, q.get("answer"), rng)
        if new_opts == opts:
            stats["unchanged"] += 1
        q["options"] = new_opts
        q["answer"] = new_ans
        stats["shuffled"] += 1

    # Part 1: 단일 문항 + audio_script(보기 낭독) 재구성
    for it in lc.get("part1", []) or []:
        opts = it.get("options") or {}
        if not opts:
            continue
        new_opts, new_ans, _ = shuffle_options(opts, it.get("answer"), rng)
        it["options"] = new_opts
        it["answer"] = new_ans
        it["audio_script"] = rebuild_part1_script(new_opts)
        stats["shuffled"] += 1
        stats["part1_audio"] += 1

    # Part 2: 단일 문항 + audio_script(질문+보기 낭독) 재구성
    for it in lc.get("part2", []) or []:
        opts = it.get("options") or {}
        if not opts:
            continue
        new_opts, new_ans, _ = shuffle_options(opts, it.get("answer"), rng)
        it["audio_script"] = rebuild_part2_script(it.get("audio_script"), new_opts)
        it["options"] = new_opts
        it["answer"] = new_ans
        stats["shuffled"] += 1
        stats["part2_audio"] += 1

    # Part 3/4: 세트 내부 문항(보기는 화면 인쇄, 오디오는 대화문이라 유지)
    for pk in ("part3", "part4"):
        for s in lc.get(pk, []) or []:
            for q in s.get("questions", []) or []:
                do_q(q)

    # Part 5: 단일
    for it in rc.get("part5", []) or []:
        do_q(it)

    # Part 6/7: 세트 내부 문항
    for pk in ("part6", "part7"):
        for s in rc.get(pk, []) or []:
            for q in s.get("questions", []) or []:
                do_q(q)

    return stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default=None, help="출력 경로(기본: 제자리 덮어쓰기)")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    with open(args.path, encoding="utf-8") as f:
        data = json.load(f)

    stats = process(data, rng)

    out = args.out or args.path
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"셔플 완료: {out}")
    print(f"  총 {stats['shuffled']}문항 셔플 "
          f"(그중 우연히 동일 배열 {stats['unchanged']}개)")
    print(f"  Part1 오디오 스크립트 재구성 {stats['part1_audio']}개, "
          f"Part2 {stats['part2_audio']}개")


if __name__ == "__main__":
    main()
