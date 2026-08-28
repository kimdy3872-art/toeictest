import json
import subprocess
import os
import sys

PROMPT_LC = """[역할 및 목적]
당신은 15년 경력의 ETS 토익(TOEIC) 수석 출제위원입니다. 
웹 기반 모의고사 시스템의 데이터베이스(DB)에 즉시 파싱 및 저장할 수 있는 '토익 LC (Part 1~4) 100문항 세트'를 생성하세요.

[회차 및 변수 정보]
- 시험 회차: 제 {SESSION_NUMBER}회차 모의고사
- 난이도: 실제 토익 정기시험 동일 수준
- 시드 키워드/주제: {RANDOM_TOPICS}
- 고유 요구사항:
  1. 기존 회차 문제 및 이전 지문과의 중복을 전면 금지하며, 신선한 비즈니스 상황을 설정하세요.
  2. 모든 파트에서 정답 위치가 (A), (B), (C), (D)에 고르게 분산되도록(각 25% 비율 근사) 출제하세요.
  3. Part 3/4의 지문 세트 키는 반드시 `set_id`로 통일하고, `context_type` 및 `speakers`(배열 내 `gender`, `accent` 속성) 정보를 필수로 포함시켜 억양이 다양하게(US, UK, AU 등) 생성되도록 하세요.

[파트별 문제 구성 및 요구 조건]
1. LC (Listening Comprehension) - 총 100문항
   - Part 1 (사진 묘사) - 6문항: 상황 설명 텍스트, 보기 (A)~(D), 정답 및 해설. 특히 클로드 코드(Claude Code) 이미지 자동 생성을 위한 영문 `image_prompt` 필드를 반드시 포함하세요.
   - Part 2 (응답 선택) - 25문항: 질문/평서문, 보기 (A)~(C), 정답 및 오답 함정 유형 포함 해설
   - Part 3 (대화문) - 39문항(13지문): 2~3인 비즈니스 대화 스크립트 + 지문당 연속 질문 3개 및 선택지
   - Part 4 (설명문) - 30문항(10지문): 1인 담화 스크립트 + 지문당 연속 질문 3개 및 선택지

[출력 및 구조 규칙]
1. 잡담, 인사말, 마크다운 기호(예: ```json 등)를 완전히 제거하고 오직 Valid JSON 1개 객체만 출력하세요.

[JSON 출력 스키마 (JSON Schema)]
{
  "lc": {
    "part1": [
      {
        "id": "LC1-01",
        "image_description": "사진 상황 묘사",
        "image_prompt": "A man points at a launch poster while colleagues sit and listen in a meeting room",
        "audio_script": "(A) ...",
        "options": {"A": "...", "B": "...", "C": "...", "D": "..."},
        "answer": "A",
        "explanation": "..."
      }
    ],
    "part2": [],
    "part3": [
      {
        "set_id": "LC3-SET01",
        "context_type": "Office Conversation",
        "speakers": [
          {"name": "Speaker 1", "gender": "Female", "accent": "US"},
          {"name": "Speaker 2", "gender": "Male", "accent": "UK"}
        ],
        "audio_script": "...",
        "questions": []
      }
    ],
    "part4": [
      {
        "set_id": "LC4-SET01",
        "context_type": "Announcement",
        "speakers": [
          {"name": "Speaker 1", "gender": "Male", "accent": "AU"}
        ],
        "audio_script": "...",
        "questions": []
      }
    ]
  }
}
"""

PROMPT_RC1 = """[역할 및 목적]
당신은 15년 경력의 ETS 토익 수석 출제위원입니다. 
'토익 RC (Part 5~6) 46문항 세트'를 생성하세요.

[회차 및 변수 정보]
- 시험 회차: 제 {SESSION_NUMBER}회차 모의고사
- 주제: {RANDOM_TOPICS}
- 요구사항: 정답 위치가 (A), (B), (C), (D)에 고르게 분산(각 25%)되도록 출제하세요. 기존 문제 중복 금지.

[구성]
- Part 5 - 30문항: 단문 공란
- Part 6 - 16문항(4지문): 장문 공란

[출력]
Valid JSON 1개 객체만 출력하세요. 마크다운 금지. 빈칸은 `--------`로 통일.

[JSON Schema]
{
  "rc": {
    "part5": [],
    "part6": []
  }
}
"""

PROMPT_RC2 = """[역할 및 목적]
당신은 15년 경력의 ETS 토익 수석 출제위원입니다. 
'토익 RC (Part 7) 54문항 세트'를 생성하세요.

[회차 및 변수 정보]
- 시험 회차: 제 {SESSION_NUMBER}회차 모의고사
- 주제: {RANDOM_TOPICS}
- 요구사항: 정답 위치가 (A), (B), (C), (D)에 고르게 분산(각 25%)되도록 출제하세요. 기존 문제 중복 금지.

[구성]
- Part 7 - 54문항: 단일/이중/삼중 지문 총 15세트.

[출력]
Valid JSON 1개 객체만 출력하세요. 마크다운 금지.

[JSON Schema]
{
  "rc": {
    "part7": []
  }
}
"""

def run_prompt_and_get_json(prompt_name, template, session_num, topics):
    print(f"[{prompt_name}] agy CLI 호출 (LLM 생성 진행 중, 약 1~3분 대기해주세요)...")
    prompt = template.replace("{SESSION_NUMBER}", str(session_num)).replace("{RANDOM_TOPICS}", topics)
    
    try:
        result = subprocess.run(["agy", "--print", prompt], capture_output=True, text=True, check=True)
        raw_text = result.stdout.strip()
    except subprocess.CalledProcessError as e:
        print(f"[{prompt_name}] agy 실행 오류: {e.stderr}")
        return {}
    
    if raw_text.startswith("```json"):
        raw_text = raw_text.replace("```json", "", 1)
        if raw_text.endswith("```"):
            raw_text = raw_text[:-3]
    elif raw_text.startswith("```"):
        raw_text = raw_text.replace("```", "", 1)
        if raw_text.endswith("```"):
            raw_text = raw_text[:-3]
    raw_text = raw_text.strip()
        
    try:
        data = json.loads(raw_text)
        print(f"[{prompt_name}] JSON 파싱 성공!")
        return data
    except json.JSONDecodeError as e:
        print(f"[{prompt_name}] JSON 파싱 오류 발생: {e}")
        return {}

def generate_full_toeic(session_num, topics):
    print(f"=== 제 {session_num}회차 토익 200문항 생성 파이프라인 시작 ===")
    
    lc_data = run_prompt_and_get_json("LC (Part 1~4)", PROMPT_LC, session_num, topics)
    rc1_data = run_prompt_and_get_json("RC (Part 5~6)", PROMPT_RC1, session_num, topics)
    rc2_data = run_prompt_and_get_json("RC (Part 7)", PROMPT_RC2, session_num, topics)
    
    print("\n--- 모든 파트 생성 완료. 병합을 시작합니다 ---")
    
    full_exam = {
        "exam_metadata": {
            "session": session_num,
            "title": f"TOEIC Full Practice Test - Vol.{session_num}",
            "total_questions": 200
        },
        "lc": lc_data.get("lc", {}),
        "rc": {
            "part5": rc1_data.get("rc", {}).get("part5", []),
            "part6": rc1_data.get("rc", {}).get("part6", []),
            "part7": rc2_data.get("rc", {}).get("part7", [])
        }
    }
    
    final_filename = f"toeic_full_vol_{session_num}.json"
    
    os.makedirs("data", exist_ok=True)
    file_path = os.path.join("data", final_filename)
    
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(full_exam, f, indent=2, ensure_ascii=False)
        
    print(f"✅ 생성 완료! [{file_path}] 파일이 성공적으로 병합 및 저장되었습니다.")

if __name__ == "__main__":
    session = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    topics = sys.argv[2] if len(sys.argv) > 2 else "해외 지사 설립, 신규 채용 면접, 사내 보안 규정 강화"
    generate_full_toeic(session_num=session, topics=topics)
