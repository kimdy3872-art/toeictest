/* =========================================================================
 * TOEIC Mock Test - 성적표 / 오답 노트 렌더링
 *  - sessionStorage 의 채점 결과(toeic_result)를 읽어 표시
 *  - 총점(LC/RC), 파트별 정답률, 문제별 해설, LC 오디오 다시 듣기
 * ========================================================================= */
(() => {
  "use strict";

  const LETTER_ONLY = new Set(["1", "2"]); // 보기 텍스트를 숨기는 LC 파트

  let result = null;
  try {
    result = JSON.parse(sessionStorage.getItem("toeic_result"));
  } catch (e) {
    result = null;
  }

  if (!result || !result.details) {
    document.getElementById("noData").classList.remove("hidden");
    document.querySelectorAll("main section").forEach((s) => s.classList.add("hidden"));
    return;
  }

  const $ = (id) => document.getElementById(id);

  /* ---------------------------------------------------------------------- */
  function init() {
    $("reportTitle").textContent = result.title || "성적표";
    if (result.session != null) {
      $("retryLink").href = `/exam/${result.session}`;
    }
    renderSummary();
    renderHistory(recordHistory());
    renderPartStats();
    renderWeakness();
    setupVocab();
    setupFilter();
    renderReview("all");
  }

  /* ---- 점수 히스토리 / 추이 ---- */
  const HISTORY_KEY = "toeic_history";

  function readHistory() {
    try {
      const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(h) ? h : [];
    } catch (e) { return []; }
  }

  function recordHistory() {
    let hist = readHistory();
    const stamp = result._submittedAt;
    // 새로고침 시 중복 저장 방지 (제출 타임스탬프 기준)
    if (stamp && !hist.some((h) => h.stamp === stamp)) {
      hist.push({
        stamp,
        session: result.session,
        date: Date.now(),
        total: result.total_score,
        lc: result.lc.score,
        rc: result.rc.score,
        correct: result.total_correct,
        questions: result.total_questions,
      });
      hist = hist.slice(-50);   // 최근 50회만 보관
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(hist)); } catch (e) { /* noop */ }
    }
    return hist;
  }

  function renderHistory(hist) {
    const clearBtn = $("historyClearBtn");
    if (clearBtn && !clearBtn._bound) {
      clearBtn._bound = true;
      clearBtn.addEventListener("click", () => {
        if (!confirm("저장된 모든 점수 기록을 삭제할까요?")) return;
        try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* noop */ }
        renderHistory([]);
      });
    }

    if (!hist.length) {
      $("historyLead").textContent = "응시 기록이 없습니다.";
      $("historyChart").innerHTML = "";
      $("historyTable").innerHTML = "";
      return;
    }

    const best = Math.max(...hist.map((h) => h.total));
    const lead = [`총 ${hist.length}회 응시`, `최고 ${best}점`];
    if (hist.length >= 2) {
      const diff = hist[hist.length - 1].total - hist[hist.length - 2].total;
      lead.push(diff >= 0 ? `지난 대비 +${diff}점` : `지난 대비 ${diff}점`);
    }
    $("historyLead").textContent = lead.join(" · ");

    $("historyChart").innerHTML = buildTrendSvg(hist);

    // 최근 응시 표 (최신순, 최대 8개)
    const recent = hist.slice(-8).reverse();
    $("historyTable").innerHTML = `
      <table class="w-full text-sm">
        <thead>
          <tr class="text-slate-400 text-xs border-b border-slate-100">
            <th class="text-left font-medium py-1">일시</th>
            <th class="text-left font-medium py-1">회차</th>
            <th class="text-right font-medium py-1">Total</th>
            <th class="text-right font-medium py-1">LC</th>
            <th class="text-right font-medium py-1">RC</th>
          </tr>
        </thead>
        <tbody>
          ${recent.map((h) => `
            <tr class="border-b border-slate-50">
              <td class="py-1.5 text-slate-500">${fmtDate(h.date)}</td>
              <td class="py-1.5 text-slate-500">Vol.${h.session}</td>
              <td class="py-1.5 text-right font-bold text-slate-800 tabular-nums">${h.total}</td>
              <td class="py-1.5 text-right text-sky-600 tabular-nums">${h.lc}</td>
              <td class="py-1.5 text-right text-emerald-600 tabular-nums">${h.rc}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }

  function buildTrendSvg(hist) {
    const W = 640, H = 200;
    const padL = 40, padR = 16, padT = 16, padB = 26;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const n = hist.length;
    const x = (i) => n === 1 ? padL + innerW / 2 : padL + innerW * (i / (n - 1));
    const y = (v) => padT + innerH * (1 - v / 990);

    // 가로 격자 (0 / 495 / 990)
    let grid = "";
    [0, 495, 990].forEach((v) => {
      const gy = y(v);
      grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#e2e8f0" stroke-width="1"/>`;
      grid += `<text x="${padL - 6}" y="${gy + 3}" text-anchor="end" font-size="10" fill="#94a3b8">${v}</text>`;
    });

    const line = (key, color, wStroke) => {
      const pts = hist.map((h, i) => `${x(i).toFixed(1)},${y(h[key]).toFixed(1)}`).join(" ");
      let dots = hist.map((h, i) =>
        `<circle cx="${x(i).toFixed(1)}" cy="${y(h[key]).toFixed(1)}" r="${key === "total" ? 3.5 : 2.5}" fill="${color}"/>`).join("");
      return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${wStroke}" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
    };

    // 마지막 total 값 라벨
    const last = hist[n - 1];
    const lx = x(n - 1), ly = y(last.total);
    const label = `<text x="${Math.min(lx, W - padR - 4).toFixed(1)}" y="${(ly - 8).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#0f172a">${last.total}</text>`;

    return `
      <svg viewBox="0 0 ${W} ${H}" class="min-w-[520px] w-full h-auto" role="img" aria-label="점수 추이 그래프">
        ${grid}
        ${line("rc", "#10b981", 1.5)}
        ${line("lc", "#0ea5e9", 1.5)}
        ${line("total", "#0f172a", 2.5)}
        ${label}
      </svg>
      <div class="flex gap-4 justify-center mt-1 text-xs text-slate-500">
        <span class="flex items-center gap-1"><span class="inline-block w-3 h-0.5" style="background:#0f172a"></span>Total</span>
        <span class="flex items-center gap-1"><span class="inline-block w-3 h-0.5" style="background:#0ea5e9"></span>LC</span>
        <span class="flex items-center gap-1"><span class="inline-block w-3 h-0.5" style="background:#10b981"></span>RC</span>
      </div>`;
  }

  function fmtDate(ts) {
    try {
      const d = new Date(ts);
      const p = (x) => String(x).padStart(2, "0");
      return `${d.getFullYear().toString().slice(2)}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch (e) { return ""; }
  }

  /* ---- 유형별 약점 진단 (category 집계) ---- */
  function renderWeakness() {
    const byCat = {};
    result.details.forEach((d) => {
      const cat = (d.category || "").trim();
      if (!cat) return;
      const g = byCat[cat] || (byCat[cat] = { correct: 0, total: 0 });
      g.total += 1;
      if (d.is_correct) g.correct += 1;
    });
    const rows = Object.keys(byCat).map((cat) => {
      const g = byCat[cat];
      return { cat, correct: g.correct, total: g.total,
               acc: Math.round(g.correct / g.total * 100) };
    });
    if (!rows.length) {                       // 카테고리 태그가 없으면 섹션 숨김
      $("weaknessSection").classList.add("hidden");
      return;
    }
    rows.sort((a, b) => a.acc - b.acc || b.total - a.total);  // 약한 유형 먼저
    const weakest = rows.filter((r) => r.acc < 100).slice(0, 3).map((r) => r.cat);
    $("weaknessLead").textContent = weakest.length
      ? `보완이 필요한 유형: ${weakest.join(", ")}`
      : "모든 유형에서 안정적인 정답률을 보였습니다. 👍";
    $("weaknessStats").innerHTML = rows.map((r) => {
      const color = r.acc >= 80 ? "bg-emerald-500"
        : r.acc >= 50 ? "bg-amber-500" : "bg-red-500";
      return `
        <div>
          <div class="flex justify-between text-sm mb-1">
            <span class="font-medium text-slate-700">${esc(r.cat)}</span>
            <span class="text-slate-500 tabular-nums">${r.correct}/${r.total} · ${r.acc}%</span>
          </div>
          <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden">
            <div class="h-full ${color} rounded-full" style="width:${r.acc}%"></div>
          </div>
        </div>`;
    }).join("");
  }

  /* ---- 회차 단어장 (key_vocabulary 집계 + CSV) ---- */
  function collectVocab(wrongOnly) {
    const seen = new Set();
    const out = [];
    result.details.forEach((d) => {
      if (wrongOnly && d.is_correct) return;
      (d.key_vocabulary || []).forEach((v) => {
        const raw = String(v).trim();
        if (!raw) return;
        const idx = raw.indexOf(":");
        const term = idx >= 0 ? raw.slice(0, idx).trim() : raw;
        const meaning = idx >= 0 ? raw.slice(idx + 1).trim() : "";
        const key = term.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ term, meaning, qnum: d.qnum });
      });
    });
    return out;
  }

  function setupVocab() {
    const btns = document.querySelectorAll(".vocab-btn");
    if (!collectVocab(false).length) {         // 단어 데이터 없으면 섹션 숨김
      $("vocabSection").classList.add("hidden");
      return;
    }
    btns.forEach((b) => b.addEventListener("click", () => {
      btns.forEach((x) => {
        x.classList.remove("bg-slate-900", "text-white");
        x.classList.add("text-slate-500", "hover:bg-slate-100");
      });
      b.classList.add("bg-slate-900", "text-white");
      b.classList.remove("text-slate-500", "hover:bg-slate-100");
      renderVocab(b.dataset.vfilter);
    }));
    document.querySelector('.vocab-btn[data-vfilter="all"]')
      .classList.add("bg-slate-900", "text-white");
    $("vocabCsvBtn").addEventListener("click", exportVocabCsv);
    renderVocab("all");
  }

  function renderVocab(filter) {
    const list = collectVocab(filter === "wrong");
    $("vocabCount").textContent = `${list.length}개 단어`;
    if (!list.length) {
      $("vocabList").innerHTML =
        `<p class="text-sm text-slate-400 col-span-full py-4 text-center">해당하는 단어가 없습니다.</p>`;
      return;
    }
    $("vocabList").innerHTML = list.map((v) => `
      <div class="flex items-baseline gap-2 border border-slate-200 rounded-lg px-3 py-2">
        <span class="font-semibold text-slate-800">${esc(v.term)}</span>
        <span class="text-sm text-slate-500 flex-1">${esc(v.meaning)}</span>
        <span class="text-[11px] text-slate-300">#${v.qnum}</span>
      </div>`).join("");
  }

  function exportVocabCsv() {
    const active = document.querySelector(".vocab-btn.bg-slate-900");
    const filter = active ? active.dataset.vfilter : "all";
    const list = collectVocab(filter === "wrong");
    const rows = [["term", "meaning", "question"]]
      .concat(list.map((v) => [v.term, v.meaning, v.qnum]));
    const csv = rows.map((r) => r.map((c) => {
      const s = String(c == null ? "" : c);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `toeic_vol${result.session || ""}_vocab_${filter}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---- 점수 요약 ---- */
  function renderSummary() {
    const lc = result.lc, rc = result.rc;
    const cards = [
      {
        label: "TOTAL SCORE", big: result.total_score, sub: "/ 990",
        detail: `${result.total_correct} / ${result.total_questions} 정답`,
        cls: "from-slate-900 to-slate-700 text-white",
      },
      {
        label: "LC · Listening", big: lc.score, sub: "/ 495",
        detail: `${lc.correct} / ${lc.total} 정답`,
        cls: "from-sky-500 to-sky-600 text-white",
      },
      {
        label: "RC · Reading", big: rc.score, sub: "/ 495",
        detail: `${rc.correct} / ${rc.total} 정답`,
        cls: "from-emerald-500 to-emerald-600 text-white",
      },
    ];
    $("scoreSummary").innerHTML = cards.map((c) => `
      <div class="rounded-xl shadow-sm p-6 bg-gradient-to-br ${c.cls}">
        <div class="text-xs font-semibold opacity-80 tracking-wide">${c.label}</div>
        <div class="mt-2 flex items-end gap-1">
          <span class="text-4xl font-extrabold tabular-nums">${c.big}</span>
          <span class="text-sm opacity-80 mb-1">${c.sub}</span>
        </div>
        <div class="text-xs opacity-80 mt-1">${c.detail}</div>
      </div>`).join("");

    if (result._elapsed != null) {
      const m = Math.floor(result._elapsed / 60);
      const s = result._elapsed % 60;
      const note = document.createElement("div");
      note.className = "md:col-span-3 text-xs text-slate-400 text-right";
      note.textContent =
        `소요 시간 ${m}분 ${s}초${result._auto ? " (시간 종료 자동 제출)" : ""} · ` +
        `점수는 ETS 환산표 기반 추정치입니다.`;
      $("scoreSummary").appendChild(note);
    }
  }

  /* ---- 파트별 정답률 ---- */
  function renderPartStats() {
    $("partStats").innerHTML = result.parts.map((p) => {
      const color = p.section === "lc" ? "bg-sky-500" : "bg-emerald-500";
      return `
        <div>
          <div class="flex justify-between text-sm mb-1">
            <span class="font-medium text-slate-700">${p.label}</span>
            <span class="text-slate-500 tabular-nums">${p.correct}/${p.total} · ${p.accuracy}%</span>
          </div>
          <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden">
            <div class="h-full ${color} rounded-full transition-all" style="width:${p.accuracy}%"></div>
          </div>
        </div>`;
    }).join("");
  }

  /* ---- 필터 ---- */
  function setupFilter() {
    const btns = document.querySelectorAll(".filter-btn");
    btns.forEach((b) => {
      b.addEventListener("click", () => {
        btns.forEach((x) => {
          x.classList.remove("bg-slate-900", "text-white");
          x.classList.add("text-slate-500", "hover:bg-slate-100");
        });
        b.classList.add("bg-slate-900", "text-white");
        b.classList.remove("text-slate-500", "hover:bg-slate-100");
        renderReview(b.dataset.filter);
      });
    });
    // 기본 활성화 = 전체
    const first = document.querySelector('.filter-btn[data-filter="all"]');
    first.classList.add("bg-slate-900", "text-white");
  }

  /* ---- 문제별 리뷰 ---- */
  function renderReview(filter) {
    let list = result.details;
    if (filter === "wrong") list = list.filter((d) => d.answered && !d.is_correct);
    else if (filter === "unanswered") list = list.filter((d) => !d.answered);

    if (!list.length) {
      $("reviewList").innerHTML =
        `<p class="text-center text-slate-400 py-8">해당하는 문제가 없습니다. 🎉</p>`;
      return;
    }
    $("reviewList").innerHTML = list.map(renderReviewItem).join("");
  }

  function renderReviewItem(d) {
    const ok = d.is_correct;
    const unanswered = !d.answered;
    const badge = ok
      ? `<span class="text-xs font-bold text-emerald-700 bg-emerald-100 rounded px-2 py-0.5">정답</span>`
      : unanswered
        ? `<span class="text-xs font-bold text-slate-600 bg-slate-200 rounded px-2 py-0.5">미표기</span>`
        : `<span class="text-xs font-bold text-red-700 bg-red-100 rounded px-2 py-0.5">오답</span>`;

    const border = ok ? "border-emerald-200" : "border-red-200";
    const showText = !LETTER_ONLY.has(String(d.part));

    // 컨텍스트 (오디오 / 지문 / 사진)
    let context = "";
    if (d.audio_id) {
      const script = d.audio_script
        ? `<details class="mt-1">
             <summary class="text-xs text-sky-600 cursor-pointer">📝 스크립트 보기 (받아쓰기·쉐도잉)</summary>
             <div class="mt-1 text-xs text-slate-600 whitespace-pre-line bg-white border border-slate-200 rounded p-2">${esc(d.audio_script)}</div>
           </details>`
        : "";
      context += `
        <div class="bg-slate-50 border border-slate-200 rounded-lg p-2 mb-2">
          <div class="text-xs text-slate-500 mb-1">🔊 다시 듣기 ${d.context_type ? "· " + esc(d.context_type) : ""}</div>
          <audio controls preload="none" class="w-full h-8">
            <source src="/static/audio/${result.session}/${encodeURIComponent(d.audio_id)}.mp3" type="audio/mpeg">
          </audio>
          ${script}
        </div>`;
    }
    if (d.image_description) {
      context += `
        <div class="mb-2">
          <img src="/static/images/${result.session}/${encodeURIComponent(d.audio_id)}.jpg" alt="Part 1 사진"
               class="w-full max-h-64 object-contain rounded-lg border border-slate-200 bg-white"
               onerror="this.style.display='none'">
          <p class="text-xs text-slate-400 italic mt-1">🖼️ ${esc(d.image_description)}</p>
        </div>`;
    }
    if (d.content) {
      context += `<details class="mb-2">
          <summary class="text-xs text-slate-500 cursor-pointer">지문 보기</summary>
          <div class="mt-1 text-xs text-slate-600 whitespace-pre-line bg-slate-50 rounded p-2">${esc(d.content)}</div>
        </details>`;
    }

    // 보기 목록 (정답/내 답 표시)
    const letters = Object.keys(d.options || {}).sort();
    const opts = letters.map((L) => {
      const isCorrect = L === d.correct_answer;
      const isYours = L === d.your_answer;
      let cls = "border-slate-200 text-slate-600";
      let mark = "";
      if (isCorrect) { cls = "border-emerald-400 bg-emerald-50 text-emerald-800 font-medium"; mark = "✔ 정답"; }
      if (isYours && !isCorrect) { cls = "border-red-400 bg-red-50 text-red-800 font-medium"; mark = "✘ 내 답"; }
      if (isYours && isCorrect) { mark = "✔ 내 답 (정답)"; }
      const text = showText && d.options[L] ? " " + esc(d.options[L]) : "";
      return `
        <div class="flex items-center gap-2 text-sm border rounded-lg px-2 py-1 ${cls}">
          <span class="w-5 font-bold">${L}</span>
          <span class="flex-1">${text}</span>
          ${mark ? `<span class="text-xs">${mark}</span>` : ""}
        </div>`;
    }).join("");

    // 해설 / 번역 / 어휘
    let extra = "";
    if (d.translation) {
      extra += `<p class="text-sm text-slate-600 mt-2"><span class="font-semibold text-slate-500">해석 </span>${esc(d.translation)}</p>`;
    }
    if (d.explanation) {
      extra += `<div class="text-sm text-slate-700 mt-2 bg-amber-50 border border-amber-200 rounded-lg p-2">
          <span class="font-semibold text-amber-700">💡 해설 </span>${esc(d.explanation)}</div>`;
    }
    if (d.key_vocabulary && d.key_vocabulary.length) {
      extra += `<div class="flex flex-wrap gap-1 mt-2">` +
        d.key_vocabulary.map((v) =>
          `<span class="text-xs bg-indigo-50 text-indigo-700 rounded px-1.5 py-0.5">${esc(v)}</span>`).join("") +
        `</div>`;
    }

    const yourLabel = unanswered
      ? '<span class="text-slate-400">미표기</span>'
      : `<span class="${ok ? "text-emerald-700" : "text-red-700"} font-semibold">${esc(d.your_answer)}</span>`;

    return `
      <div class="border ${border} rounded-xl p-4">
        <div class="flex items-center gap-2 mb-2 flex-wrap">
          <span class="w-8 h-8 rounded-full bg-slate-900 text-white text-sm font-bold flex items-center justify-center">${d.qnum}</span>
          <span class="text-xs text-slate-400">Part ${d.part}${d.category ? " · " + esc(d.category) : ""}</span>
          ${badge}
          <span class="ml-auto text-xs text-slate-500">내 답 ${yourLabel} · 정답 <span class="text-emerald-700 font-semibold">${esc(d.correct_answer)}</span></span>
        </div>
        ${context}
        ${showText && d.question ? `<p class="text-sm font-medium text-slate-800 mb-2">${esc(d.question)}</p>` : ""}
        <div class="space-y-1">${opts}</div>
        ${extra}
      </div>`;
  }

  function esc(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
