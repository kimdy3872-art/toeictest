/* =========================================================================
 * TOEIC Mock Test - 응시 페이지 로직 (AFCAT 스타일 3분할 UI)
 *  - 시험 데이터 로드 & 렌더링 (Part 1~7)
 *  - 120분 타이머 카운트다운(Hrs:Min:Sec, 0 도달 시 자동 제출)
 *  - 좌측 문제 팔레트: 상태 색상(응답/검토/미응답/미방문) + 번호 클릭 이동
 *  - 우측 현황(Overview) 패널 + 대형 타이머
 *  - 응답 마킹(문제 <-> 팔레트 동기화), 검토 표시(북마크), 방문 추적
 *  - 파트 하단 이전/다음/파트지우기, 제출 -> 서버 채점 -> 결과 페이지
 * ========================================================================= */
(() => {
  "use strict";

  const SESSION = parseInt(document.body.dataset.session, 10);
  const EXAM_MINUTES = 120;
  const LETTER = ["A", "B", "C", "D", "E"];

  const state = {
    exam: null,
    exams: [],
    answers: {},          // { qnum: "A" }
    bookmarks: {},        // { qnum: true } - 검토 표시
    visited: {},          // { qnum: true } - 방문한 문제
    order: [],            // 등장 순서대로의 part 번호 목록
    activePart: null,
    focusedQnum: null,    // 팔레트에서 강조할 현재 문제
    remaining: EXAM_MINUTES * 60,
    timerId: null,
    timerStarted: false,
    submitted: false,
    navigating: false,
    pickedSession: SESSION,
  };

  const els = {
    breadcrumbPart: document.getElementById("breadcrumbPart"),
    paletteCard: document.getElementById("paletteCard"),
    palettePanel: document.getElementById("palettePanel"),
    paletteBackdrop: document.getElementById("paletteBackdrop"),
    togglePalette: document.getElementById("togglePalette"),
    qArea: document.getElementById("questionArea"),
    timerH: document.getElementById("timerH"),
    timerM: document.getElementById("timerM"),
    timerS: document.getElementById("timerS"),
    timerMini: document.getElementById("timerMini"),
    submitBtn: document.getElementById("submitBtn"),
    exitBtn: document.getElementById("exitBtn"),
    sessionChangeBtn: document.getElementById("sessionChangeBtn"),
    instrBtn: document.getElementById("instrBtn"),
    instrModal: document.getElementById("instrModal"),
    instrCloseBtn: document.getElementById("instrCloseBtn"),
    instrOkBtn: document.getElementById("instrOkBtn"),
    // overview
    ovTotal: document.getElementById("ovTotal"),
    ovVisited: document.getElementById("ovVisited"),
    ovNotVisited: document.getElementById("ovNotVisited"),
    ovAnswered: document.getElementById("ovAnswered"),
    ovNotAnswered: document.getElementById("ovNotAnswered"),
    ovMarked: document.getElementById("ovMarked"),
    // start screen
    startScreen: document.getElementById("startScreen"),
    sessionList: document.getElementById("sessionList"),
    startBtn: document.getElementById("startBtn"),
    startCancelBtn: document.getElementById("startCancelBtn"),
    resumeBanner: document.getElementById("resumeBanner"),
    resumeInfo: document.getElementById("resumeInfo"),
    resumeBtn: document.getElementById("resumeBtn"),
  };

  /* ---------------------------------------------------------------------- */
  /* 초기화                                                                  */
  /* ---------------------------------------------------------------------- */
  async function init() {
    bindStaticEvents();
    try {
      const [examRes, examsRes] = await Promise.all([
        fetch(`/api/exam/${SESSION}`),
        fetch(`/api/exams`),
      ]);
      if (!examRes.ok) throw new Error(`HTTP ${examRes.status}`);
      state.exam = await examRes.json();
      state.exams = examsRes.ok ? ((await examsRes.json()).exams || []) : [];
    } catch (e) {
      els.qArea.innerHTML =
        `<div class="text-center text-red-500 py-20">시험 데이터를 불러오지 못했습니다.<br>${e}</div>`;
      return;
    }
    render();
    buildStartScreen();

    // 다른 회차를 골라 "시작하기"를 누르면 /exam/{sel} 로 페이지가 새로 로드된다.
    // 그때는 시작 화면을 다시 띄우지 않고 곧바로 응시를 시작한다(이중 클릭 방지).
    if (consumeAutoStart()) {
      const p = loadProgress();
      const answered = p && p.answers ? Object.keys(p.answers).length : 0;
      if (p && (answered > 0 || p.timerStarted)) {
        resumeExam();
      } else {
        beginExam();
      }
    } else {
      showStartScreen(false);
    }
  }

  function consumeAutoStart() {
    try {
      const v = sessionStorage.getItem("toeic_autostart");
      if (v && parseInt(v, 10) === SESSION) {
        sessionStorage.removeItem("toeic_autostart");
        return true;
      }
    } catch (e) { /* noop */ }
    return false;
  }

  function bindStaticEvents() {
    els.submitBtn.addEventListener("click", () => confirmSubmit());
    els.exitBtn.addEventListener("click", exitExam);
    els.togglePalette.addEventListener("click", () => setPalette(true));
    els.paletteBackdrop.addEventListener("click", () => setPalette(false));
    els.startBtn.addEventListener("click", beginExam);
    els.startCancelBtn.addEventListener("click", () => hideStartScreen());
    els.resumeBtn.addEventListener("click", resumeExam);
    if (els.sessionChangeBtn)
      els.sessionChangeBtn.addEventListener("click", () => showStartScreen(true));
    if (els.instrBtn) els.instrBtn.addEventListener("click", () => toggleInstr(true));
    if (els.instrCloseBtn) els.instrCloseBtn.addEventListener("click", () => toggleInstr(false));
    if (els.instrOkBtn) els.instrOkBtn.addEventListener("click", () => toggleInstr(false));

    window.addEventListener("beforeunload", (e) => {
      if (state.submitted || state.navigating) return;
      if (Object.keys(state.answers).length === 0) return;
      e.preventDefault();
      e.returnValue = "";
    });
  }

  function toggleInstr(open) {
    els.instrModal.classList.toggle("hidden", !open);
  }

  function exitExam() {
    if (!state.submitted && Object.keys(state.answers).length > 0 &&
        !confirm("응시를 종료하고 나가시겠습니까? 저장된 진행분은 이어하기로 다시 열 수 있습니다.")) {
      return;
    }
    state.navigating = true;
    window.location.href = "/";
  }

  /* ---------------------------------------------------------------------- */
  /* 회차 선택 시작 화면                                                       */
  /* ---------------------------------------------------------------------- */
  function buildStartScreen() {
    const exams = state.exams.length ? state.exams
      : [{ session: SESSION, title: state.exam.title, question_count: totalQuestions() }];
    els.sessionList.innerHTML = "";
    exams.forEach((ex) => {
      const card = document.createElement("button");
      card.type = "button";
      card.dataset.session = ex.session;
      card.className =
        "session-card text-left rounded-xl border-2 border-slate-200 p-3 hover:border-indigo-400 transition";
      card.innerHTML =
        `<div class="font-bold text-slate-900">Vol.${ex.session}</div>
         <div class="text-xs text-slate-500 mt-0.5 truncate">${escapeHtml(ex.title || "")}</div>
         <div class="text-xs text-indigo-600 mt-1">${ex.question_count}문항</div>`;
      card.addEventListener("click", () => selectSessionCard(ex.session));
      els.sessionList.appendChild(card);
    });
    state.pickedSession = SESSION;
    highlightSessionCard(SESSION);
  }

  function selectSessionCard(session) {
    state.pickedSession = session;
    highlightSessionCard(session);
  }

  function highlightSessionCard(session) {
    els.sessionList.querySelectorAll(".session-card").forEach((c) => {
      const on = parseInt(c.dataset.session, 10) === session;
      c.classList.toggle("border-indigo-500", on);
      c.classList.toggle("bg-indigo-50", on);
      c.classList.toggle("border-slate-200", !on);
    });
  }

  function showStartScreen(reopen) {
    els.startCancelBtn.classList.toggle("hidden", !reopen);
    els.startBtn.textContent = reopen ? "이 회차로 계속" : "시작하기";
    state.pickedSession = SESSION;
    highlightSessionCard(SESSION);
    if (reopen) els.resumeBanner.classList.add("hidden");
    else renderResumeState();
    els.startScreen.classList.remove("hidden");
  }

  function hideStartScreen() {
    els.startScreen.classList.add("hidden");
  }

  function beginExam() {
    const sel = state.pickedSession;
    if (sel !== SESSION) {
      if (Object.keys(state.answers).length > 0 &&
          !confirm("현재 회차의 답안이 사라집니다. 선택한 회차로 이동할까요?")) {
        return;
      }
      state.navigating = true;
      try { sessionStorage.setItem("toeic_autostart", String(sel)); } catch (e) { /* noop */ }
      window.location.href = `/exam/${sel}`;
      return;
    }
    if (!state.timerStarted) {
      clearProgress();
      state.answers = {};
      state.bookmarks = {};
      state.visited = {};
      state.remaining = EXAM_MINUTES * 60;
      markPartVisited(state.activePart);
      refreshAll();
      state.timerStarted = true;
      startTimer();
    }
    hideStartScreen();
  }

  /* ---------------------------------------------------------------------- */
  /* 자동 저장 / 복원 (localStorage)                                          */
  /* ---------------------------------------------------------------------- */
  const STORAGE_KEY = `toeic_progress_${SESSION}`;

  function saveProgress() {
    if (state.submitted) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        session: SESSION,
        answers: state.answers,
        bookmarks: state.bookmarks,
        visited: state.visited,
        remaining: state.remaining,
        timerStarted: state.timerStarted,
        savedAt: Date.now(),
      }));
    } catch (e) { /* 용량초과 등 무시 */ }
  }

  function clearProgress() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* noop */ }
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (!p || p.session !== SESSION) return null;
      return p;
    } catch (e) { return null; }
  }

  function renderResumeState() {
    const p = loadProgress();
    const answered = p && p.answers ? Object.keys(p.answers).length : 0;
    const hasProgress = p && (answered > 0 || p.timerStarted);
    if (!hasProgress) {
      els.resumeBanner.classList.add("hidden");
      return;
    }
    const m = Math.floor((p.remaining || 0) / 60);
    const s = (p.remaining || 0) % 60;
    els.resumeInfo.textContent =
      `저장된 응시 기록 · ${answered}문항 마킹 · 남은 시간 ` +
      `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    els.resumeBanner.classList.remove("hidden");
  }

  function resumeExam() {
    const p = loadProgress();
    if (!p) { hideStartScreen(); beginExam(); return; }
    state.answers = { ...(p.answers || {}) };
    state.bookmarks = { ...(p.bookmarks || {}) };
    state.visited = { ...(p.visited || {}) };
    state.remaining = typeof p.remaining === "number" ? p.remaining : EXAM_MINUTES * 60;
    markPartVisited(state.activePart);
    refreshAll();
    hideStartScreen();
    state.timerStarted = true;
    startTimer();
  }

  /* ---------------------------------------------------------------------- */
  /* 렌더링                                                                  */
  /* ---------------------------------------------------------------------- */
  function render() {
    state.order = state.exam.parts.map((p) => p.part);
    state.activePart = state.order[0];

    renderQuestions();
    renderPalette();
    showPart(state.activePart);
    refreshAll();
  }

  function refreshAll() {
    syncAllQuestions();
    syncAllPalette();
    updateOverview();
  }

  function renderQuestions() {
    els.qArea.innerHTML = "";
    state.exam.parts.forEach((p) => {
      const section = document.createElement("div");
      section.dataset.partSection = p.part;
      section.className = "part-section space-y-6";

      const head = document.createElement("div");
      head.className = "border-b border-slate-200 pb-2";
      head.innerHTML =
        `<h2 class="text-lg font-bold text-slate-900">${escapeHtml(p.label)}</h2>
         <p class="text-xs text-slate-400 mt-0.5">${partHint(p.part)}</p>`;
      section.appendChild(head);

      p.blocks.forEach((b) => section.appendChild(renderBlock(b)));
      section.appendChild(renderPartNav(p.part));
      els.qArea.appendChild(section);
    });
  }

  // 각 파트 맨 아래의 이동/지우기 버튼
  function renderPartNav(part) {
    const idx = state.order.indexOf(part);
    const prevPart = idx > 0 ? state.order[idx - 1] : null;
    const nextPart = idx < state.order.length - 1 ? state.order[idx + 1] : null;

    const nav = document.createElement("div");
    nav.className =
      "flex items-center justify-between gap-3 pt-5 mt-2 border-t border-slate-200";

    // 왼쪽: 이전 파트
    if (prevPart !== null) {
      const prev = document.createElement("button");
      prev.type = "button";
      prev.className =
        "inline-flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 transition";
      prev.innerHTML = `← 이전 · ${escapeHtml(partShortLabel(prevPart))}`;
      prev.addEventListener("click", () => showPart(prevPart));
      nav.appendChild(prev);
    } else {
      nav.appendChild(document.createElement("span"));
    }

    // 오른쪽: 파트 지우기 + 다음/제출
    const right = document.createElement("div");
    right.className = "flex items-center gap-2";

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className =
      "inline-flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition";
    clear.innerHTML = "이 파트 지우기";
    clear.addEventListener("click", () => clearPart(part));
    right.appendChild(clear);

    if (nextPart !== null) {
      const next = document.createElement("button");
      next.type = "button";
      next.className =
        "inline-flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 transition";
      next.innerHTML = `다음 · ${escapeHtml(partShortLabel(nextPart))} →`;
      next.addEventListener("click", () => showPart(nextPart));
      right.appendChild(next);
    } else {
      const done = document.createElement("button");
      done.type = "button";
      done.className =
        "inline-flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-indigo-900 hover:bg-indigo-800 transition";
      done.innerHTML = `제출하기 ➤`;
      done.addEventListener("click", () => confirmSubmit());
      right.appendChild(done);
    }
    nav.appendChild(right);
    return nav;
  }

  function partShortLabel(part) {
    const p = state.exam.parts.find((x) => x.part === part);
    if (p && p.label) return p.label.split("·")[0].trim();
    return `Part ${part}`;
  }

  function partHint(part) {
    return ({
      1: "사진을 보고 오디오를 들은 뒤 알맞은 보기를 고르세요.",
      2: "질문/평서문을 듣고 가장 알맞은 응답을 고르세요.",
      3: "대화를 듣고 관련 질문에 답하세요.",
      4: "설명문을 듣고 관련 질문에 답하세요.",
      5: "빈칸에 알맞은 보기를 고르세요.",
      6: "지문의 빈칸에 알맞은 보기를 고르세요.",
      7: "지문을 읽고 질문에 답하세요.",
    })[part] || "";
  }

  function renderBlock(b) {
    const wrap = document.createElement("div");
    wrap.className =
      "bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4";

    if (b.kind === "lc-image") {
      wrap.appendChild(imageBox(b.audio_id, b.image_description));
    }
    if (b.audio_id) wrap.appendChild(audioPlayer(b.audio_id, b));
    if (b.kind === "rc-passage" && b.content) {
      wrap.appendChild(passageBox(b.context_type, b.content));
    }

    const qwrap = document.createElement("div");
    qwrap.className = "space-y-5";
    b.questions.forEach((q) => qwrap.appendChild(renderQuestion(q, b)));
    wrap.appendChild(qwrap);
    return wrap;
  }

  function audioPlayer(audioId, b) {
    const box = document.createElement("div");
    box.className = "bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2";
    let meta = "";
    if (b.context_type) meta += `<span class="text-xs font-medium text-slate-500">${escapeHtml(b.context_type)}</span>`;
    if (b.speakers && b.speakers.length) {
      const s = b.speakers
        .map((sp) => `${sp.gender || ""} · ${sp.accent || ""}`.trim())
        .join(" / ");
      meta += `<span class="text-xs text-slate-400"> · ${escapeHtml(s)}</span>`;
    }
    box.innerHTML =
      `<div class="flex items-center gap-1">🔊 ${meta || '<span class="text-xs text-slate-400">Listening</span>'}</div>
       <audio controls preload="none" class="w-full h-9">
         <source src="/static/audio/${SESSION}/${encodeURIComponent(audioId)}.mp3" type="audio/mpeg">
       </audio>
       <p class="audio-missing hidden text-xs text-amber-600">⚠ 음성 파일이 없습니다. <code>python generate_audio.py</code> 로 생성하세요.</p>`;
    const audio = box.querySelector("audio");
    audio.addEventListener("error", () => {
      box.querySelector(".audio-missing").classList.remove("hidden");
    }, true);
    return box;
  }

  function imageBox(imageId, desc) {
    const box = document.createElement("div");
    box.className =
      "rounded-lg overflow-hidden border border-slate-200 bg-slate-50";

    const img = document.createElement("img");
    img.src = `/static/images/${SESSION}/${encodeURIComponent(imageId)}.jpg`;
    img.alt = "Part 1 사진";
    img.className = "w-full max-h-96 object-contain mx-auto bg-white";

    const fallback = document.createElement("div");
    fallback.className = "hidden p-4 text-center";
    fallback.innerHTML =
      `<div class="text-3xl mb-1">🖼️</div>
       <p class="text-xs text-slate-400 mb-1">사진 (설명)</p>
       <p class="text-sm text-slate-600 italic">${escapeHtml(desc || "")}</p>
       <p class="text-[11px] text-amber-600 mt-1">이미지 생성 전입니다. <code>python generate_images.py</code></p>`;
    img.addEventListener("error", () => {
      img.classList.add("hidden");
      fallback.classList.remove("hidden");
    });

    box.appendChild(img);
    box.appendChild(fallback);
    return box;
  }

  function passageBox(type, content) {
    const box = document.createElement("div");
    box.className = "bg-slate-50 border border-slate-200 rounded-lg p-4";
    box.innerHTML =
      `${type ? `<div class="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">${escapeHtml(type)}</div>` : ""}
       <div class="text-sm leading-relaxed text-slate-700 whitespace-pre-line">${escapeHtml(content)}</div>`;
    return box;
  }

  function renderQuestion(q, b) {
    const showText = !(b.kind === "lc-image" || b.kind === "lc-response");
    const letters = Object.keys(q.options || {}).sort();
    const usable = letters.length ? letters : ["A", "B", "C", "D"];

    const box = document.createElement("div");
    box.className = "q-anchor";
    box.id = `q-${q.qnum}`;
    box.dataset.qnum = q.qnum;

    // 헤더: 번호 + (문제/카테고리) + 검토 표시 버튼
    const header = document.createElement("div");
    header.className = "flex items-start gap-2 mb-2";
    let mid = `<div class="pt-1 flex-1">`;
    if (q.category) {
      mid += `<span class="inline-block text-[11px] text-indigo-600 bg-indigo-50 rounded px-1.5 py-0.5 mb-1">${escapeHtml(q.category)}</span>`;
    }
    if (showText && q.question) {
      mid += `<p class="text-sm text-slate-800 font-medium leading-relaxed">${escapeHtml(q.question)}</p>`;
    } else if (!showText) {
      mid += `<p class="text-sm text-slate-400 italic">오디오를 듣고 정답을 고르세요.</p>`;
    }
    mid += `</div>`;
    header.innerHTML =
      `<span class="shrink-0 w-8 h-8 rounded-full bg-slate-900 text-white text-sm font-bold flex items-center justify-center">${q.qnum}</span>
       ${mid}`;

    const bookmarkBtn = document.createElement("button");
    bookmarkBtn.type = "button";
    bookmarkBtn.dataset.bookmark = q.qnum;
    bookmarkBtn.className =
      "bookmark-btn shrink-0 inline-flex items-center gap-1 text-xs font-medium rounded-lg px-2 py-1 border transition";
    bookmarkBtn.innerHTML = `<span class="bk-icon">🔖</span><span class="bk-text hidden sm:inline">검토 표시</span>`;
    bookmarkBtn.addEventListener("click", () => toggleBookmark(q.qnum));
    header.appendChild(bookmarkBtn);
    box.appendChild(header);

    // 보기
    const choices = document.createElement("div");
    choices.className = "pl-10 space-y-1.5";
    usable.forEach((L) => {
      const text = q.options ? q.options[L] : "";
      const label = document.createElement("button");
      label.type = "button";
      label.className =
        "choice w-full text-left flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer border border-transparent hover:bg-slate-50";
      label.dataset.qnum = q.qnum;
      label.dataset.letter = L;
      label.innerHTML =
        `<span class="bubble shrink-0 w-6 h-6 rounded-full border-2 border-slate-300 text-xs font-bold flex items-center justify-center text-slate-500">${L}</span>
         ${showText && text ? `<span class="text-sm text-slate-700">${escapeHtml(text)}</span>` : ""}`;
      label.addEventListener("click", () => toggleAnswer(q.qnum, L));
      choices.appendChild(label);
    });
    box.appendChild(choices);
    return box;
  }

  /* ---------------------------------------------------------------------- */
  /* 문제 팔레트 (좌측)                                                       */
  /* ---------------------------------------------------------------------- */
  function renderPalette() {
    els.paletteCard.innerHTML = "";
    state.exam.parts.forEach((p) => {
      const group = document.createElement("div");
      group.dataset.palGroup = p.part;

      const head = document.createElement("div");
      head.className = "flex items-center justify-between px-0.5 mb-1.5";
      head.innerHTML =
        `<span class="text-xs font-semibold text-slate-500">${escapeHtml(partShortLabel(p.part))}</span>
         <span class="flex items-center gap-2 text-[11px] text-slate-400">
           <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span><span data-cnt-answered="${p.part}">0</span></span>
           <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-violet-500 inline-block"></span><span data-cnt-marked="${p.part}">0</span></span>
         </span>`;
      group.appendChild(head);

      const grid = document.createElement("div");
      grid.className = "grid grid-cols-5 gap-1.5";
      p.blocks.forEach((b) => {
        b.questions.forEach((q) => {
          const tile = document.createElement("button");
          tile.type = "button";
          tile.dataset.tile = q.qnum;
          tile.dataset.part = p.part;
          tile.className = "pal-tile relative w-9 h-9 rounded-md text-xs font-semibold border transition";
          tile.textContent = q.qnum;
          tile.title = "문제로 이동";
          tile.addEventListener("click", () => goToQuestion(q.qnum, p.part));
          grid.appendChild(tile);
        });
      });
      group.appendChild(grid);
      els.paletteCard.appendChild(group);
    });
  }

  // 팔레트 타일 상태 색상 적용
  const TILE_BASE = "pal-tile relative w-9 h-9 rounded-md text-xs font-semibold border transition";
  function syncPaletteTile(qnum) {
    const tile = els.paletteCard.querySelector(`[data-tile="${qnum}"]`);
    if (!tile) return;
    const answered = state.answers[qnum] != null;
    const marked = !!state.bookmarks[qnum];
    const visited = !!state.visited[qnum];
    const focused = state.focusedQnum === qnum;

    let cls = TILE_BASE;
    if (marked) {
      cls += " bg-violet-500 text-white border-violet-500 hover:bg-violet-600";
    } else if (answered) {
      cls += " bg-emerald-500 text-white border-emerald-500 hover:bg-emerald-600";
    } else if (visited) {
      cls += " bg-white text-slate-600 border-slate-300 hover:border-slate-400";
    } else {
      cls += " bg-slate-100 text-slate-500 border-transparent hover:bg-slate-200";
    }
    if (focused) cls += " ring-2 ring-slate-900 ring-offset-1";
    tile.className = cls;

    // 응답 + 검토 표시 동시: 초록 점 표시
    let dot = tile.querySelector(".pal-dot");
    if (marked && answered) {
      if (!dot) {
        dot = document.createElement("span");
        dot.className = "pal-dot absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-emerald-500 border border-white";
        tile.appendChild(dot);
      }
    } else if (dot) {
      dot.remove();
    }
  }

  function syncPaletteGroup(part) {
    const p = state.exam.parts.find((x) => x.part === part);
    if (!p) return;
    let answered = 0, marked = 0;
    p.blocks.forEach((b) => b.questions.forEach((q) => {
      if (state.answers[q.qnum] != null) answered++;
      if (state.bookmarks[q.qnum]) marked++;
    }));
    const a = els.paletteCard.querySelector(`[data-cnt-answered="${part}"]`);
    const m = els.paletteCard.querySelector(`[data-cnt-marked="${part}"]`);
    if (a) a.textContent = answered;
    if (m) m.textContent = marked;
  }

  function syncAllPalette() {
    eachQuestion((q) => syncPaletteTile(q.qnum));
    state.order.forEach((part) => syncPaletteGroup(part));
  }

  /* ---------------------------------------------------------------------- */
  /* 마킹 / 검토표시 / 동기화                                                 */
  /* ---------------------------------------------------------------------- */
  function toggleAnswer(qnum, letter) {
    if (state.answers[qnum] === letter) {
      delete state.answers[qnum];      // 같은 보기 재클릭 -> 해제
    } else {
      state.answers[qnum] = letter;
    }
    afterMarkChange(qnum);
  }

  function toggleBookmark(qnum) {
    if (state.bookmarks[qnum]) delete state.bookmarks[qnum];
    else state.bookmarks[qnum] = true;
    afterMarkChange(qnum);
  }

  function afterMarkChange(qnum) {
    state.visited[qnum] = true;
    syncQuestion(qnum);
    syncPaletteTile(qnum);
    syncPaletteGroup(qnumPart(qnum));
    updateOverview();
    saveProgress();
  }

  function clearPart(part) {
    const p = state.exam.parts.find((x) => x.part === part);
    if (!p) return;
    const label = partShortLabel(part);
    if (!confirm(`${label}의 응답과 검토 표시를 모두 지울까요?`)) return;
    p.blocks.forEach((b) => b.questions.forEach((q) => {
      delete state.answers[q.qnum];
      delete state.bookmarks[q.qnum];
      syncQuestion(q.qnum);
      syncPaletteTile(q.qnum);
    }));
    syncPaletteGroup(part);
    updateOverview();
    saveProgress();
  }

  function syncQuestion(qnum) {
    const box = document.getElementById(`q-${qnum}`);
    if (!box) return;
    const chosen = state.answers[qnum];
    box.querySelectorAll(".choice").forEach((el) => {
      const on = el.dataset.letter === chosen;
      el.classList.toggle("bg-slate-900", on);
      el.classList.toggle("border-slate-900", on);
      const bubble = el.querySelector(".bubble");
      bubble.classList.toggle("bg-white", on);
      bubble.classList.toggle("text-slate-900", on);
      bubble.classList.toggle("border-slate-900", on);
      bubble.classList.toggle("text-slate-500", !on);
      bubble.classList.toggle("border-slate-300", !on);
      el.querySelectorAll("span:not(.bubble)").forEach((s) =>
        s.classList.toggle("text-white", on));
    });
    // 검토 표시 버튼 상태
    syncBookmarkBtn(qnum);
  }

  function syncBookmarkBtn(qnum) {
    const btn = document.querySelector(`[data-bookmark="${qnum}"]`);
    if (!btn) return;
    const on = !!state.bookmarks[qnum];
    btn.classList.toggle("bg-violet-500", on);
    btn.classList.toggle("text-white", on);
    btn.classList.toggle("border-violet-500", on);
    btn.classList.toggle("text-slate-500", !on);
    btn.classList.toggle("border-slate-300", !on);
    const t = btn.querySelector(".bk-text");
    if (t) t.textContent = on ? "표시됨" : "검토 표시";
  }

  function syncAllQuestions() {
    eachQuestion((q) => syncQuestion(q.qnum));
  }

  /* ---------------------------------------------------------------------- */
  /* 현황(Overview)                                                          */
  /* ---------------------------------------------------------------------- */
  function updateOverview() {
    const total = totalQuestions();
    const answered = Object.keys(state.answers).length;
    const marked = Object.keys(state.bookmarks).length;
    const visited = Object.keys(state.visited).length;
    const notVisited = Math.max(0, total - visited);
    const notAnswered = Math.max(0, visited - answered);
    if (els.ovTotal) els.ovTotal.textContent = total;
    if (els.ovVisited) els.ovVisited.textContent = visited;
    if (els.ovNotVisited) els.ovNotVisited.textContent = notVisited;
    if (els.ovAnswered) els.ovAnswered.textContent = answered;
    if (els.ovNotAnswered) els.ovNotAnswered.textContent = notAnswered;
    if (els.ovMarked) els.ovMarked.textContent = marked;
  }

  function totalQuestions() {
    let n = 0;
    state.exam.parts.forEach((p) =>
      p.blocks.forEach((b) => (n += b.questions.length)));
    return n;
  }

  // 파트/문제 순회 헬퍼
  function eachQuestion(fn) {
    state.exam.parts.forEach((p) =>
      p.blocks.forEach((b) => b.questions.forEach((q) => fn(q, p, b))));
  }
  function qnumPart(qnum) {
    let part = null;
    eachQuestion((q, p) => { if (q.qnum === qnum) part = p.part; });
    return part;
  }
  function markPartVisited(part) {
    const p = state.exam.parts.find((x) => x.part === part);
    if (!p) return;
    p.blocks.forEach((b) => b.questions.forEach((q) => { state.visited[q.qnum] = true; }));
  }

  /* ---------------------------------------------------------------------- */
  /* 파트 전환 / 이동                                                         */
  /* ---------------------------------------------------------------------- */
  function showPart(part) {
    state.activePart = part;
    markPartVisited(part);
    document.querySelectorAll(".part-section").forEach((sec) => {
      sec.classList.toggle("hidden", parseInt(sec.dataset.partSection, 10) !== part);
    });
    // breadcrumb + 팔레트 그룹 강조
    els.breadcrumbPart.textContent = fullPartLabel(part);
    els.paletteCard.querySelectorAll("[data-pal-group]").forEach((g) => {
      const on = parseInt(g.dataset.palGroup, 10) === part;
      g.classList.toggle("ring-1", on);
      g.classList.toggle("ring-slate-200", on);
      g.classList.toggle("rounded-lg", on);
      g.classList.toggle("bg-slate-50", on);
      g.classList.toggle("p-1.5", on);
      g.classList.toggle("-m-1.5", on);
    });
    syncAllPalette();
    updateOverview();
    saveProgress();
    window.scrollTo({ top: 0 });
  }

  function fullPartLabel(part) {
    const p = state.exam.parts.find((x) => x.part === part);
    return p && p.label ? p.label : `Part ${part}`;
  }

  function goToQuestion(qnum, part) {
    if (part !== state.activePart) showPart(part);
    state.focusedQnum = qnum;
    syncAllPalette();
    setPalette(false);
    requestAnimationFrame(() => {
      const box = document.getElementById(`q-${qnum}`);
      if (box) {
        box.scrollIntoView({ behavior: "smooth", block: "center" });
        box.classList.add("ring-2", "ring-indigo-400", "rounded-lg");
        setTimeout(() =>
          box.classList.remove("ring-2", "ring-indigo-400", "rounded-lg"), 1200);
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 팔레트 토글 (모바일 오버레이)                                            */
  /* ---------------------------------------------------------------------- */
  function setPalette(open) {
    if (window.innerWidth >= 1024) return;
    if (open) {
      els.palettePanel.classList.remove("hidden");
      els.palettePanel.classList.add(
        "fixed", "top-14", "left-0", "bottom-0", "z-40", "shadow-2xl");
      els.paletteBackdrop.classList.remove("hidden");
    } else {
      els.palettePanel.classList.remove(
        "fixed", "top-14", "left-0", "bottom-0", "z-40", "shadow-2xl");
      els.palettePanel.classList.add("hidden");
      els.paletteBackdrop.classList.add("hidden");
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 타이머                                                                  */
  /* ---------------------------------------------------------------------- */
  function startTimer() {
    updateTimerLabel();
    state.timerId = setInterval(() => {
      state.remaining -= 1;
      if (state.remaining <= 0) {
        state.remaining = 0;
        updateTimerLabel();
        clearInterval(state.timerId);
        alert("시험 시간이 종료되었습니다. 자동으로 제출합니다.");
        submit(true);
        return;
      }
      updateTimerLabel();
      if (state.remaining % 5 === 0) saveProgress();
    }, 1000);
  }

  function updateTimerLabel() {
    const rem = Math.max(0, state.remaining);
    const h = Math.floor(rem / 3600);
    const m = Math.floor((rem % 3600) / 60);
    const s = rem % 60;
    const pad = (n) => String(n).padStart(2, "0");
    if (els.timerH) els.timerH.textContent = pad(h);
    if (els.timerM) els.timerM.textContent = pad(m);
    if (els.timerS) els.timerS.textContent = pad(s);
    if (els.timerMini) els.timerMini.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
    // 5분 이하 경고
    if (rem <= 300) {
      [els.timerH, els.timerM, els.timerS].forEach((el) => el && el.classList.add("text-red-600"));
      if (els.timerMini) {
        els.timerMini.classList.remove("bg-slate-900");
        els.timerMini.classList.add("bg-red-600", "animate-pulse");
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 제출                                                                    */
  /* ---------------------------------------------------------------------- */
  function confirmSubmit() {
    const answered = Object.keys(state.answers).length;
    const total = totalQuestions();
    const marked = Object.keys(state.bookmarks).length;
    let msg = answered < total
      ? `아직 ${total - answered}문제가 미표기 상태입니다.\n`
      : "모든 문제를 표기했습니다.\n";
    if (marked > 0) msg += `검토 표시 ${marked}문제가 있습니다.\n`;
    msg += "제출하시겠습니까?";
    if (confirm(msg)) submit(false);
  }

  async function submit(auto) {
    if (state.submitted) return;
    state.submitted = true;
    if (state.timerId) clearInterval(state.timerId);
    clearProgress();
    els.submitBtn.disabled = true;
    els.submitBtn.textContent = "채점 중…";

    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: SESSION, answers: state.answers }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      result._elapsed = EXAM_MINUTES * 60 - state.remaining;
      result._auto = auto;
      result._submittedAt = Date.now();
      sessionStorage.setItem("toeic_result", JSON.stringify(result));
      window.location.href = `/result?session=${SESSION}`;
    } catch (e) {
      alert("채점 중 오류가 발생했습니다: " + e);
      state.submitted = false;
      els.submitBtn.disabled = false;
      els.submitBtn.innerHTML = `Review and Submit <span aria-hidden="true">➤</span>`;
    }
  }

  /* ---------------------------------------------------------------------- */
  function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
