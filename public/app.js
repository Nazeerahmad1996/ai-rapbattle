const $ = (s) => document.querySelector(s);
const views = {
  arena: ["#view-setup"],
  battle: ["#view-battle"],
  history: ["#view-history"],
};
let battleId = null,
  es = null,
  fighters = [],
  adapters = [],
  modes = [],
  selectedMode = "rap";
const RAP = { id: "rap", name: "Rap Battle", emoji: "🎤", round: "ROUND" };
let stageMode = RAP,
  stageLanguage = "English";
let setupReady = false,
  modesReady = false,
  finished = false,
  replaying = false,
  launching = false;

// --- Free Neural Voice (TTS) Director & Queue ---
let voiceEnabled = true;
try {
  voiceEnabled = localStorage.getItem("botbrawl:voice") !== "off";
} catch {
  /* storage optional */
}
const ttsBlobCache = new Map();
let speechQueue = [];
let speechBusy = false;
let activeAudio = null;
let activeStop = null;

function fetchTtsUrl(text, role, language, mode = "rap") {
  const key = `${role}|${language}|${mode}|${text}`;
  if (ttsBlobCache.has(key)) return ttsBlobCache.get(key);
  const p = fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, role, language, mode }),
  })
    .then(async (r) => {
      if (!r.ok) throw new Error("tts http " + r.status);
      const blob = await r.blob();
      if (!blob.size) throw new Error("empty audio");
      return URL.createObjectURL(blob);
    })
    .catch((err) => {
      ttsBlobCache.delete(key);
      throw err;
    });
  ttsBlobCache.set(key, p);
  return p;
}

function speakWithBrowserFallback(text, role, language) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const langMap = {
        Hindi: "hi-IN",
        Hinglish: "en-IN",
        Urdu: "ur-PK",
        "Roman Urdu": "en-IN",
        Punjabi: "pa-IN",
        Spanish: "es-ES",
        French: "fr-FR",
        German: "de-DE",
        Portuguese: "pt-BR",
        Arabic: "ar-SA",
        Russian: "ru-RU",
        Turkish: "tr-TR",
        Japanese: "ja-JP",
        Korean: "ko-KR",
        Chinese: "zh-CN",
      };
      u.lang = langMap[language] || "en-US";
      u.pitch = role === "a" ? 0.94 : role === "b" ? 1.08 : 0.86;
      u.rate = 1.02;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      activeStop = () => {
        try {
          window.speechSynthesis.cancel();
        } catch {
          /* ignore */
        }
        resolve();
      };
      window.speechSynthesis.speak(u);
    } catch {
      resolve();
    }
  });
}

async function playSpeechItem(item) {
  const { text, role, language, sideEl, btnEl } = item;
  if (sideEl) {
    sideEl.classList.add("speaking");
    const st = sideEl.querySelector(".performer-status");
    if (st && !sideEl.classList.contains("active")) st.textContent = "SPEAKING VERSE";
  }
  if (btnEl) {
    btnEl.classList.add("playing");
    btnEl.textContent = "■ STOP";
  }
  try {
    const url = await item.urlPromise;
    await new Promise((resolve) => {
      const audio = new Audio(url);
      activeAudio = audio;
      const done = () => {
        if (activeAudio === audio) activeAudio = null;
        activeStop = null;
        resolve();
      };
      activeStop = () => {
        audio.pause();
        audio.currentTime = 0;
        done();
      };
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    });
  } catch {
    await speakWithBrowserFallback(text, role, language);
  } finally {
    if (sideEl) {
      sideEl.classList.remove("speaking");
      const st = sideEl.querySelector(".performer-status");
      if (st && !sideEl.classList.contains("active")) st.textContent = "TURN COMPLETE";
    }
    if (btnEl) {
      btnEl.classList.remove("playing");
      btnEl.textContent = "▶ VOICE";
    }
  }
}

async function drainSpeechQueue() {
  if (speechBusy) return;
  speechBusy = true;
  try {
    while (speechQueue.length && voiceEnabled) {
      const next = speechQueue.shift();
      await playSpeechItem(next);
    }
  } finally {
    speechBusy = false;
  }
}

function stripInlineMd(s) {
  return String(s ?? "")
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1")
    .replace(/\*(?=\S)([^*\n]+?)(?<=\S)\*/g, "$1")
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

function cleanStageName(raw) {
  const s = String(raw ?? "").trim();
  const outer = s.match(/^([^()]+?)\s*\((.+)\)$/);
  if (!outer) return s;
  const inner = outer[2]
    .replace(/\s*\((?:High|Medium|Low|Default|Fast)\)\s*$/i, "")
    .trim();
  return !inner || /^default$/i.test(inner) ? outer[1].trim() : inner;
}

function enqueueSpeech({ text, role, sideEl = null, btnEl = null, force = false }) {
  const clean = stripInlineMd(text).trim();
  if (!clean) return;
  if (!voiceEnabled && !force) return;
  const language = stageLanguage || "English";
  const mode = stageMode?.id || selectedMode || "rap";
  const urlPromise = fetchTtsUrl(clean, role, language, mode);
  if (force) {
    stopAllSpeech();
  }
  speechQueue.push({ text: clean, role, language, sideEl, btnEl, urlPromise });
  drainSpeechQueue();
}

function stopAllSpeech() {
  speechQueue = [];
  if (activeStop) activeStop();
  activeAudio = null;
  activeStop = null;
  document.querySelectorAll(".fighter.speaking").forEach((el) => {
    el.classList.remove("speaking");
  });
  document.querySelectorAll(".round-play-btn.playing").forEach((b) => {
    b.classList.remove("playing");
    b.textContent = "▶ VOICE";
  });
}
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const MODE_COPY = {
  rap: "Rhymes. Rhythm. Rivalry.",
  roast: "Bring the heat.",
  debate: "Make your point.",
  poetry: "Let the words hit.",
  story: "Plot your next move.",
};
const topicDrafts = new Map();
const topicSeen = new Map();
let modeInitialized = false;

function topicPool(id) {
  return modes.find((m) => m.id === id)?.topics ?? [];
}

function seenTopics(id) {
  if (!topicSeen.has(id)) {
    let saved = [];
    try {
      saved = JSON.parse(localStorage.getItem("topic-picks:" + id) || "[]");
    } catch {
      /* storage is optional */
    }
    topicSeen.set(
      id,
      Array.isArray(saved) ? saved.filter((x) => typeof x === "string") : [],
    );
  }
  return topicSeen.get(id);
}

function rememberTopic(id, title, seen = seenTopics(id)) {
  topicSeen.set(id, [...seen.filter((t) => t !== title), title]);
  try {
    localStorage.setItem(
      "topic-picks:" + id,
      JSON.stringify(topicSeen.get(id)),
    );
  } catch {
    /* storage is optional */
  }
}

// Selected topics get their own cycle; displaying a chip never consumes a pick.
function nextTopic(id) {
  const pool = topicPool(id);
  if (!pool.length) return null;
  let seen = seenTopics(id);
  let available = pool.filter(
    (t) => !seen.includes(t.title) && t.title !== $("#topic").value,
  );
  if (!available.length) {
    const last = seen.at(-1);
    seen = [];
    available = pool.filter(
      (t) => t.title !== $("#topic").value && t.title !== last,
    );
    if (!available.length)
      available = pool.filter((t) => t.title !== $("#topic").value);
  }
  const chosen =
    available[Math.floor(Math.random() * available.length)] ?? pool[0];
  rememberTopic(id, chosen.title, seen);
  return chosen;
}

function updateTopicRoles() {
  const preset = topicPool(selectedMode).find(
    (t) => t.title === $("#topic").value,
  );
  $("#topic-roles").textContent =
    preset && selectedMode !== "story"
      ? `P1: ${preset.a} · P2: ${preset.b}`
      : selectedMode === "story"
        ? "One story. Two writers. Every turn picks up where the last one left off."
        : "Your topic, their rivalry. Name two sides with “vs” or give them a premise.";
  document.querySelectorAll(".topic-drop").forEach((button) => {
    const active = button.dataset.title === $("#topic").value;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function chooseTopic(title) {
  $("#topic").value = title;
  topicDrafts.set(selectedMode, title);
  if (topicPool(selectedMode).some((t) => t.title === title))
    rememberTopic(selectedMode, title);
  updateTopicRoles();
  updateSummary();
}

function renderTopicDrops() {
  const pool = topicPool(selectedMode);
  $("#shuffle-topic").disabled = !pool.length;
  const current = pool.find((t) => t.title === $("#topic").value);
  const options = current ? [current] : [];
  const candidates = pool.filter((t) => t.title !== current?.title);
  while (options.length < Math.min(3, pool.length) && candidates.length) {
    const [next] = candidates.splice(
      Math.floor(Math.random() * candidates.length),
      1,
    );
    options.push(next);
  }
  $("#topic-drops").innerHTML = options
    .map(
      (t) =>
        `<button class="topic-drop" type="button" data-title="${esc(t.title)}" aria-pressed="false">${esc(t.label)}</button>`,
    )
    .join("");
  document
    .querySelectorAll(".topic-drop")
    .forEach(
      (button) => (button.onclick = () => chooseTopic(button.dataset.title)),
    );
  updateTopicRoles();
}

// Finite, interruptible entrances. Reading surfaces never move in the background.
function reveal(targets, delay = 0) {
  if (reducedMotion.matches || !window.anime || replaying) return;
  anime.remove(targets);
  anime({
    targets,
    opacity: [0, 1],
    translateY: [18, 0],
    duration: 580,
    delay: anime.stagger(65, { start: delay }),
    easing: "easeOutExpo",
  });
}
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches && window.anime) {
    for (const animation of [...anime.running])
      animation.seek(animation.duration);
  }
});

function updateSummary() {
  const mode = modes.find((m) => m.id === selectedMode);
  const unit = mode?.lengthLabel.split(" / ")[0].toLowerCase() || "lines";
  $("#match-summary").textContent =
    `${$("#rounds").value} rounds · ${$("#lines").value} ${unit} · ${$("#language").value}`;
  $("#start").disabled =
    launching || !setupReady || !modesReady || !$("#topic").value.trim();
}

function syncFighter(side, animate = false) {
  const adapter = adapters.find((a) => a.id === $("#sel-" + side).value);
  $("#fighter-name-" + side).textContent = adapter?.name || "SELECT A FIGHTER";
  const tag = $(".corner-" + side + " .fighter-ready");
  tag.textContent = adapter?.available ? "● SELECTED" : "○ UNAVAILABLE";
  if (animate) reveal(".corner-" + side + " .character-caption");
}
const cap = (s) => s[0] + s.slice(1).toLowerCase();
const pad2 = (n) => String(n).padStart(2, "0");
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

// Bespoke architectural SVG icons instead of stock OS emojis
const MODE_ICONS = {
  rap: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`,
  roast: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,
  debate: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>`,
  poetry: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" x2="2" y1="8" y2="22"/><line x1="17.5" x2="9" y1="15" y2="15"/></svg>`,
  story: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
};

function show(name) {
  for (const v of ["#view-setup", "#view-battle", "#view-history"])
    $(v).hidden = true;
  views[name].forEach((v) => ($(v).hidden = false));
  $("#tab-arena").classList.toggle("active", name !== "history");
  $("#tab-history").classList.toggle("active", name === "history");
  for (const tab of ["arena", "history"]) {
    if ((name === "history") === (tab === "history"))
      $("#tab-" + tab).setAttribute("aria-current", "page");
    else $("#tab-" + tab).removeAttribute("aria-current");
  }
  reveal(views[name][0]);
  window.scrollTo({ top: 0, behavior: "instant" });
  const heading = $(views[name][0]).querySelector("h1");
  heading?.setAttribute("tabindex", "-1");
  heading?.focus({ preventScroll: true });
}

function fillModels(adapterSel, modelSel) {
  const a = adapters.find((x) => x.id === $(adapterSel).value);
  $(modelSel).innerHTML = (a?.models ?? [])
    .map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`)
    .join("");
}
function link(adapterSel, modelSel) {
  $(adapterSel).onchange = () => {
    fillModels(adapterSel, modelSel);
    if (adapterSel !== "#sel-judge") syncFighter(adapterSel.slice(-1), true);
    else $(modelSel).disabled = $(adapterSel).value === "none";
  };
  fillModels(adapterSel, modelSel);
}

async function loadAdapters() {
  adapters = await api("/api/adapters");
  const list = adapters;
  const opts = list
    .map(
      (a) =>
        `<option value="${esc(a.id)}" ${a.available ? "" : "disabled"}>${esc(a.name)}${a.available ? "" : " (not installed)"}</option>`,
    )
    .join("");
  $("#sel-a").innerHTML = opts;
  $("#sel-b").innerHTML = opts;
  $("#sel-judge").innerHTML = `<option value="none">No judge</option>` + opts;
  const avail = list.filter((a) => a.available).map((a) => a.id);
  $("#sel-a").value = avail[0] ?? "";
  $("#sel-b").value = avail[1] ?? avail[0] ?? "";
  $("#sel-judge").value = avail[0] ?? "none";
  link("#sel-a", "#model-a");
  link("#sel-b", "#model-b");
  link("#sel-judge", "#model-judge");
  setupReady = avail.length > 0;
  syncFighter("a");
  syncFighter("b");
  $("#model-judge").disabled = $("#sel-judge").value === "none";
  $("#connection-status").innerHTML =
    `<i></i> ${avail.length} FIGHTERS AVAILABLE`;
  if (!setupReady)
    throw new Error(
      "No AI platforms found. Install and sign in to a supported AI tool, then reload the arena.",
    );
  updateSummary();
}

function selectMode(id) {
  if (modeInitialized && id === selectedMode) return;
  const current = $("#topic").value;
  const custom =
    current.trim() &&
    !modes.some(
      (m) => m.topic === current || m.topics?.some((t) => t.title === current),
    );
  if (id !== selectedMode && current) topicDrafts.set(selectedMode, current);
  selectedMode = id;
  const m = modes.find((x) => x.id === id);
  if (!m) return;
  modeInitialized = true;
  document.querySelectorAll(".mode-card").forEach((c) => {
    const active = c.dataset.id === id;
    c.classList.toggle("active", active);
    c.setAttribute("aria-checked", String(active));
    c.tabIndex = active ? 0 : -1;
  });
  if (!custom)
    $("#topic").value = topicDrafts.get(id) || nextTopic(id)?.title || m.topic;
  renderTopicDrops();
  $("#length-label").textContent = m.lengthLabel;
  $("#lines").value = m.length;
  if (!launching)
    $("#start").innerHTML =
      '<span>ENTER THE ARENA</span><span aria-hidden="true">↗</span>';
  updateSummary();
}

async function loadModes() {
  modes = await api("/api/modes");
  $("#modes").innerHTML = modes
    .map((m, idx) => {
      const icon = MODE_ICONS[m.id] || MODE_ICONS.rap;
      return `<button type="button" role="radio" aria-checked="false" class="mode-card" data-id="${esc(m.id)}">
      <div class="mode-card-top">
        <span class="mode-index">${pad2(idx + 1)}</span>
        <span class="mode-icon">${icon}</span>
      </div>
      <span class="mode-check" aria-hidden="true">✓</span>
      <span class="mode-name">${esc(m.name)}</span><span class="mode-desc">${esc(MODE_COPY[m.id] || m.name)}</span>
    </button>`;
    })
    .join("");
  document.querySelectorAll(".mode-card").forEach((c, i) => {
    c.onclick = () => selectMode(c.dataset.id);
    c.onkeydown = (e) => {
      let next = i;
      if (["ArrowRight", "ArrowDown"].includes(e.key))
        next = (i + 1) % modes.length;
      else if (["ArrowLeft", "ArrowUp"].includes(e.key))
        next = (i + modes.length - 1) % modes.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = modes.length - 1;
      else return;
      e.preventDefault();
      selectMode(modes[next].id);
      document.querySelectorAll(".mode-card")[next].focus();
    };
  });
  modesReady = true;
  selectMode(selectedMode);
  reveal(".mode-card");
}

function updateMomentum(totals) {
  const a = Number(totals?.a) || 0;
  const b = Number(totals?.b) || 0;
  const sum = a + b;
  const pctA = sum === 0 ? 50 : Math.round((a / sum) * 100);
  const pctB = 100 - pctA;
  const elA = $("#momentum-a"),
    elB = $("#momentum-b");
  if (elA && elB) {
    elA.style.width = `${pctA}%`;
    elB.style.width = `${pctB}%`;
  }
}

function resetStage(info) {
  stopAllSpeech();
  finished = false;
  stageMode = info.mode ?? RAP;
  stageLanguage = info.language || "English";
  fighters = info.fighters;
  $("#b-mode-pill").textContent = stageMode.name.toUpperCase();
  const langPill = $("#b-lang-pill");
  if (info.language && info.language !== "English") {
    langPill.textContent = info.language.toUpperCase();
    langPill.hidden = false;
  } else {
    langPill.hidden = true;
  }
  $("#b-topic").textContent = info.topic;
  const liveInd = $("#live-indicator");
  if (liveInd) liveInd.classList.remove("concluded");
  const liveTxt = $("#live-status-text");
  if (liveTxt) liveTxt.textContent = "ON AIR";

  const palette = ["#a78bfa", "#d5fb46"];
  ["a", "b"].forEach((s, i) => {
    const el = $("#side-" + s);
    const color = palette[i] || fighters[i].color;
    el.style.setProperty("--c", color);
    el.querySelector(".fname").textContent = fighters[i].name;
    el.querySelector(".score").textContent = "0";
    el.querySelector(".verse").innerHTML = "";
    el.classList.remove("active");
    el.querySelector(".performer-status").textContent = "ON STANDBY";
    $("#vote-" + s).innerHTML =
      `<span class="vote-corner">CORNER ${s.toUpperCase()}</span><span class="vote-name">${esc(fighters[i].name)}</span>`;
    $("#vote-" + s).style.setProperty("--c", color);
  });
  updateMomentum({ a: 0, b: 0 });
  $("#judge-box").hidden = true;
  $("#judge-box").innerHTML = "";
  $("#vote-box").hidden = true;
  $("#round-label").textContent = `${stageMode.round} 01`;
}

function scrollVerseToBottom(sideEl) {
  const scroller = sideEl?.querySelector(".verse-scroller");
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

function handle(ev) {
  const side = ev.side && $("#side-" + ev.side);
  switch (ev.type) {
    case "start":
      resetStage(ev);
      break;
    case "round":
      $("#round-label").textContent = `${stageMode.round} ${pad2(ev.round)}`;
      break;
    case "verse-start": {
      side.classList.add("active");
      side.querySelector(".performer-status").textContent = "ON THE MIC";
      const v = side.querySelector(".verse");
      const block = document.createElement("div");
      block.className = "verse-round";
      block.innerHTML = `<div class="round-head"><span class="round-tag">${esc(stageMode.round)} ${pad2(ev.round)}</span><button type="button" class="round-play-btn" hidden>▶ VOICE</button></div><div class="round-body" dir="auto"><span class="cur"></span></div>`;
      v.appendChild(block);
      reveal(block);
      v.classList.add("live");
      scrollVerseToBottom(side);
      break;
    }
    case "verse-chunk": {
      const cur = side.querySelector(".verse .cur:last-child");
      if (cur) cur.textContent += ev.text;
      scrollVerseToBottom(side);
      break;
    }
    case "verse-end": {
      if (ev.performer) {
        const i = ev.side === "a" ? 0 : 1;
        fighters[i] = { ...fighters[i], ...ev.performer };
        side.querySelector(".fname").textContent = ev.performer.stageName || ev.performer.name;
        $("#vote-" + ev.side).querySelector(".vote-name").textContent = ev.performer.stageName || ev.performer.name;
      }
      const cleanVerse = stripInlineMd(ev.verse);
      side.classList.remove("active");
      side.querySelector(".performer-status").textContent = "TURN COMPLETE";
      side.querySelector(".verse").classList.remove("live");
      const cur = side.querySelector(".verse .cur:last-child");
      if (cur) {
        cur.textContent = cleanVerse;
        cur.classList.remove("cur");
      }
      const lastRound = side.querySelector(".verse .verse-round:last-child");
      const playBtn = lastRound?.querySelector(".round-play-btn");
      if (playBtn) {
        playBtn.hidden = false;
        playBtn.onclick = () => {
          if (playBtn.classList.contains("playing")) stopAllSpeech();
          else enqueueSpeech({ text: cleanVerse, role: ev.side, sideEl: side, btnEl: playBtn, force: true });
        };
      }
      if (!replaying) {
        enqueueSpeech({ text: cleanVerse, role: ev.side, sideEl: side, btnEl: playBtn });
      }
      scrollVerseToBottom(side);
      break;
    }
    case "judge": {
      const j = $("#judge-box");
      j.hidden = false;
      j.innerHTML = `<div class="judge-deliberating"><span class="judge-pulse"></span><span>Adjudicator is scoring ${esc(cap(stageMode.round))}…</span></div>`;
      break;
    }
    case "round-end":
      if (ev.scores) {
        const sA = $("#side-a .score"),
          sB = $("#side-b .score");
        sA.textContent = ev.totals.a;
        sB.textContent = ev.totals.b;
        sA.classList.remove("pop");
        sB.classList.remove("pop");
        void sA.offsetWidth;
        sA.classList.add("pop");
        sB.classList.add("pop");
        updateMomentum(ev.totals);

        // Structured LTR scoreboard + isolated dir="auto" reason so RTL Urdu/Arabic never scrambles LTR names/scores
        const j = $("#judge-box");
        j.hidden = false;
        j.innerHTML = `
          <div class="judge-head" dir="ltr">
            <span class="judge-badge">ADJUDICATOR · ${esc(stageMode.round)} ${pad2(ev.round)}</span>
            <div class="judge-scoreline">
              <span class="j-team j-team-a"><bdi>${esc(fighters[0].name)}</bdi> <strong>${esc(ev.scores.a)}</strong></span>
              <span class="j-sep">:</span>
              <span class="j-team j-team-b"><strong>${esc(ev.scores.b)}</strong> <bdi>${esc(fighters[1].name)}</bdi></span>
              <button type="button" class="round-play-btn judge-play-btn">▶ VOICE</button>
            </div>
          </div>
          <p class="judge-reason" dir="auto">${esc(ev.scores.reason)}</p>
        `;
        const jBtn = j.querySelector(".judge-play-btn");
        if (jBtn) {
          jBtn.onclick = () => {
            if (jBtn.classList.contains("playing")) stopAllSpeech();
            else enqueueSpeech({ text: ev.scores.reason, role: "judge", btnEl: jBtn, force: true });
          };
        }
        if (!replaying && ev.scores.reason) {
          enqueueSpeech({ text: ev.scores.reason, role: "judge", btnEl: jBtn });
        }
      }
      break;
    case "end": {
      finished = true;
      $("#round-label").textContent = "FINAL BELL";
      const liveInd = $("#live-indicator");
      if (liveInd) liveInd.classList.add("concluded");
      const liveTxt = $("#live-status-text");
      if (liveTxt) liveTxt.textContent = "COMPLETE";
      openVoting(ev.totals);
      break;
    }
    case "error":
      finished = true;
      $("#round-label").textContent = "MATCH INTERRUPTED";
      $("#live-status-text").textContent = "STOPPED";
      $("#live-indicator").classList.add("concluded");
      $("#judge-box").hidden = false;
      $("#judge-box").innerHTML =
        `<p class="judge-badge">BATTLE INTERRUPTED</p><p class="judge-reason">${esc(ev.message)}</p>`;
      document.querySelectorAll(".fighter").forEach((f) => {
        f.classList.remove("active");
        f.querySelector(".performer-status").textContent = "BATTLE STOPPED";
      });
      $("#stop").hidden = true;
      break;
  }
}

function openVoting(totals) {
  $("#vote-box").hidden = false;
  $("#stop").hidden = true;
  const { a, b } = totals;
  $("#winner").textContent =
    !a && !b
      ? "Match Concluded"
      : a === b
        ? "Adjudicator's Verdict: Dead Heat Draw"
        : `Winner by Adjudication: ${fighters[a > b ? 0 : 1].name}`;
  $("#vote-tally").textContent = "";
  for (const s of ["a", "b"]) $("#vote-" + s).disabled = false;
  reveal("#vote-box");
}

async function watch(id) {
  es?.close();
  battleId = id;
  finished = false;
  $("#b-topic").textContent = "Loading the showdown…";
  $("#round-label").textContent = "GET READY";
  $("#judge-box").hidden = true;
  $("#vote-box").hidden = true;
  document.querySelectorAll(".verse").forEach((v) => (v.textContent = ""));
  $("#stop").hidden = true;
  show("battle");
  // Finished battles render in one pass; live matches keep the event stream.
  try {
    const battle = await api(`/api/battles/${id}`);
    if (battleId !== id) return;
    replaying = true;
    try {
      for (const event of battle.events) handle(event);
    } finally {
      replaying = false;
    }
    restoreVotes(battle);
    requestAnimationFrame(() =>
      document
        .querySelectorAll(".verse-scroller")
        .forEach((s) => (s.scrollTop = 0)),
    );
    reveal(".fighter");
    return;
  } catch {
    /* A running battle is only held in memory, so connect to its stream. */
  }
  if (battleId !== id) return;
  es = new EventSource(`/api/battles/${id}/stream`);
  es.onmessage = (e) => handle(JSON.parse(e.data));
  es.onerror = () => {
    es.close();
    if (!finished)
      handle({
        type: "error",
        message:
          "Connection lost. Open this battle again from the archive when it finishes.",
      });
  };
  $("#stop").hidden = false;
}

function restoreVotes(battle) {
  if (battle.status !== "voting") return;
  const votes = battle.votes || { a: 0, b: 0 };
  if (votes.a || votes.b)
    $("#vote-tally").textContent =
      `Crowd votes — ${fighters[0].name}: ${votes.a} · ${fighters[1].name}: ${votes.b}`;
  if (battle.final) renderFinal(battle.final);
}

function renderFinal(final) {
  $("#winner").textContent =
    final.winner === "draw"
      ? "DEAD HEAT. RUN IT BACK?"
      : `${fighters[final.winner === "a" ? 0 : 1].name} WINS`;
  $("#side-a .score").textContent = final.a;
  $("#side-b .score").textContent = final.b;
  updateMomentum(final);
}

function readVote() {
  try {
    return localStorage.getItem("voted:" + battleId);
  } catch {
    return null;
  }
}

async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error("Cannot reach the server. Is it still running?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}
const post = (path, body) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

$("#start").onclick = async () => {
  if (launching || !$("#topic").value.trim()) return;
  launching = true;
  $("#setup-error").hidden = true;
  $("#start").disabled = true;
  $("#start").innerHTML =
    '<span>PREPARING THE ARENA…</span><span aria-hidden="true">↗</span>';
  const body = {
    mode: selectedMode,
    a: $("#sel-a").value,
    b: $("#sel-b").value,
    judge: $("#sel-judge").value,
    topic: $("#topic").value,
    language: $("#language").value,
    aModel: $("#model-a").value,
    bModel: $("#model-b").value,
    judgeModel: $("#model-judge").value,
    rounds: $("#rounds").value,
    lines: $("#lines").value,
    clean: $("#clean").checked,
  };
  try {
    const data = await post("/api/battles", body);
    watch(data.id);
  } catch (e) {
    $("#setup-error").textContent = e.message;
    $("#setup-error").hidden = false;
  } finally {
    launching = false;
    $("#start").innerHTML =
      '<span>ENTER THE ARENA</span><span aria-hidden="true">↗</span>';
    updateSummary();
  }
};

$("#stop").onclick = async () => {
  stopAllSpeech();
  $("#stop").disabled = true;
  try {
    await post(`/api/battles/${battleId}/stop`);
  } catch (e) {
    $("#round-label").textContent = e.message;
  } finally {
    $("#stop").disabled = false;
  }
};
$("#again").onclick = () => {
  stopAllSpeech();
  es?.close();
  show("arena");
  refreshModels();
};
for (const s of ["a", "b"]) {
  $("#vote-" + s).onclick = async () => {
    const votedBattle = battleId;
    const key = "voted:" + votedBattle;
    if (readVote()) {
      $("#vote-tally").textContent = "You already voted in this battle.";
      return;
    }
    for (const side of ["a", "b"]) $("#vote-" + side).disabled = true;
    try {
      const r = await post(`/api/battles/${votedBattle}/vote`, { side: s });
      try {
        localStorage.setItem(key, s);
      } catch {
        /* voting still works with storage disabled */
      }
      if (battleId !== votedBattle) return;
      $("#vote-tally").textContent =
        `Audience Tally — ${fighters[0].name}: ${r.votes.a} · ${fighters[1].name}: ${r.votes.b}`;
      renderFinal(r.final);
    } catch (e) {
      if (battleId !== votedBattle) return;
      $("#vote-tally").textContent = e.message;
      for (const side of ["a", "b"]) $("#vote-" + side).disabled = false;
    }
  };
}

async function loadHistory() {
  $("#history-list").innerHTML =
    '<li class="empty-history">Loading your battle tapes…</li>';
  let list;
  try {
    list = await api("/api/battles");
  } catch (e) {
    $("#history-list").innerHTML =
      `<li class="history-error">${esc(e.message)}</li>`;
    return;
  }
  $("#archive-count").textContent = `${pad2(list.length)} MATCHES`;
  $("#history-list").innerHTML = list.length
    ? ""
    : '<li class="empty-history">No recorded battles yet.</li>';
  for (const b of list) {
    const li = document.createElement("li");
    li.className = "history-entry";
    const bm = modes.find((m) => m.id === (b.config.mode ?? "rap")) ?? RAP;
    const lang =
      b.config.language && b.config.language !== "English"
        ? `<span class="hist-pill">${esc(b.config.language)}</span>`
        : "";
    li.innerHTML = `<button class="history-open" type="button">
      <div class="hist-left">
        <span class="hist-mode">${esc(bm.name)}</span>
        <span class="hist-matchup"><bdi>${esc(b.fighters[0].name)}</bdi> <span class="hist-vs">vs</span> <bdi>${esc(b.fighters[1].name)}</bdi></span>
        <span class="hist-topic" dir="auto"></span>
      </div>
      <div class="hist-right">
        ${lang}
        <span class="hist-status status-${esc(b.status)}">${b.status === "voting" ? "COMPLETED" : b.status === "error" ? "INTERRUPTED" : esc(b.status)}</span>
        <span class="hist-date">${esc(new Date(b.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</span>
        <span class="hist-arrow" aria-hidden="true">↗</span>
      </div></button>
    `;
    li.querySelector(".hist-topic").textContent = b.config.topic;
    li.querySelector("button").onclick = () => watch(b.id);
    $("#history-list").appendChild(li);
  }
  reveal(".history-entry");
}

async function refreshModels() {
  try {
    adapters = await api("/api/adapters");
    for (const [a, m] of [
      ["#sel-a", "#model-a"],
      ["#sel-b", "#model-b"],
      ["#sel-judge", "#model-judge"],
    ]) {
      const prev = $(m).value;
      fillModels(a, m);
      if ([...$(m).options].some((o) => o.value === prev)) $(m).value = prev;
    }
  } catch {
    /* keep the existing lists */
  }
}

// Voice Toggle & Broadcast / Cinema View Toggle
function syncVoiceBtn() {
  const btn = $("#voice-toggle");
  const lbl = $("#voice-label");
  if (btn) {
    btn.classList.toggle("active", voiceEnabled);
    btn.setAttribute("aria-pressed", String(voiceEnabled));
  }
  if (lbl) lbl.textContent = voiceEnabled ? "VOICE ON" : "VOICE OFF";
}
function toggleVoice() {
  voiceEnabled = !voiceEnabled;
  try {
    localStorage.setItem("botbrawl:voice", voiceEnabled ? "on" : "off");
  } catch {
    /* ignore */
  }
  if (!voiceEnabled) stopAllSpeech();
  syncVoiceBtn();
}
$("#voice-toggle")?.addEventListener("click", toggleVoice);
syncVoiceBtn();

function toggleCinema() {
  document.body.classList.toggle("cinema-mode");
  const active = document.body.classList.contains("cinema-mode");
  const btn = $("#cinema-toggle");
  if (btn) btn.classList.toggle("active", active);
  btn?.setAttribute("aria-pressed", String(active));
}
$("#cinema-toggle")?.addEventListener("click", toggleCinema);
document.addEventListener("keydown", (e) => {
  if (
    ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName) ||
    e.metaKey ||
    e.ctrlKey
  )
    return;
  if (e.key.toLowerCase() === "f") {
    e.preventDefault();
    toggleCinema();
  } else if (e.key.toLowerCase() === "v") {
    e.preventDefault();
    toggleVoice();
  }
});

$("#tab-arena").onclick = () => {
  stopAllSpeech();
  show("arena");
  refreshModels();
};
$("#tab-history").onclick = () => {
  stopAllSpeech();
  loadHistory();
  show("history");
};

// --- Deterministic Director Mode for Headless Video Rendering (16:9 & 9:16 Shorts) ---
const searchStr = String(window.location?.search || "");
if (/(?:^|[?&])cinema=1(?:&|$)/.test(searchStr)) {
  document.body.classList.add("cinema-mode");
}
if (/(?:^|[?&])aspect=9(?:%3A|:)16(?:&|$)/i.test(searchStr)) {
  document.body.classList.add("aspect-9-16");
}

function buildPhraseSchedule(rawText, wordsMeta, durationMs) {
  const clean = stripInlineMd(rawText);
  const tokens = clean.match(/\S+|\s+/g) || [];
  const wordIndices = [];
  for (let i = 0; i < tokens.length; i++) {
    if (/\S/.test(tokens[i])) wordIndices.push(i);
  }
  if (!wordIndices.length) return [];

  const meta = Array.isArray(wordsMeta) ? wordsMeta : [];
  const usableDur = Math.max(400, durationMs * 0.92);

  // Map each non-whitespace word token to an exact millisecond offset
  const wordOffsets = wordIndices.map((_, k) => {
    if (meta.length > 0) {
      const mappedIdx = Math.min(
        meta.length - 1,
        Math.floor((k / Math.max(1, wordIndices.length)) * meta.length),
      );
      return Math.max(0, Number(meta[mappedIdx]?.offsetMs) || 0);
    }
    return Math.round((k / Math.max(1, wordIndices.length)) * usableDur);
  });

  // Group into natural 4-word spoken phrases (also breaking cleanly on newlines or sentence punctuation)
  const phrases = [];
  let chunkStartWord = 0;
  for (let k = 0; k < wordIndices.length; k++) {
    const tokIdx = wordIndices[k];
    const tok = tokens[tokIdx];
    const nextWs = tokens[tokIdx + 1] || "";
    const wordsInChunk = k - chunkStartWord + 1;
    const hasNewline = nextWs.includes("\n");
    const endsSentence = /[.!?؟।]$/.test(tok) && wordsInChunk >= 2;
    const isLast = k === wordIndices.length - 1;

    if (isLast || hasNewline || endsSentence || wordsInChunk >= 5) {
      const firstTokIdx = chunkStartWord === 0 ? 0 : wordIndices[chunkStartWord];
      const lastTokIdx = isLast ? tokens.length - 1 : tokIdx + (/\s/.test(nextWs) ? 1 : 0);
      const pastHtml = esc(tokens.slice(0, firstTokIdx).join(""));
      const activeRaw = tokens.slice(firstTokIdx, lastTokIdx + 1).join("");
      const captionWords = wordIndices
        .slice(chunkStartWord, k + 1)
        .map((idx) => tokens[idx]);

      phrases.push({
        offsetMs: wordOffsets[chunkStartWord],
        pastHtml,
        activeHtml: esc(activeRaw),
        captionText: captionWords.join(" "),
      });
      chunkStartWord = k + 1;
    }
  }
  return phrases;
}

function updateShortsCaption(speaker, text, accentRole = "both") {
  const bar = $("#shorts-caption-bar");
  if (!bar) return;
  if (!text) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.dataset.role = accentRole;
  const sp = $("#shorts-caption-speaker");
  const tx = $("#shorts-caption-text");
  if (sp) sp.textContent = speaker || "";
  if (tx) tx.textContent = text;
}

window.__renderPosterFrame = function (manifest) {
  voiceEnabled = false;
  stopAllSpeech();
  document.body.classList.add("cinema-mode", "director-mode", "poster-mode");
  for (const v of ["#view-setup", "#view-battle", "#view-history"]) {
    const el = $(v);
    if (el) el.hidden = true;
  }
  const stage = $("#poster-stage");
  if (!stage) return false;
  stage.hidden = false;

  const b = manifest.battle;
  const mInfo = modes.find((x) => x.id === b.config.mode) || {
    name: (b.config.mode || "Rap").toUpperCase() + " BATTLE",
  };
  const sA = b.fighters[0].stageName || cleanStageName(b.fighters[0].name);
  const sB = b.fighters[1].stageName || cleanStageName(b.fighters[1].name);

  $("#poster-mode").textContent = `AI ${mInfo.name.toUpperCase()}`;
  const langEl = $("#poster-lang");
  if (b.config.language && b.config.language !== "English") {
    langEl.textContent = b.config.language.toUpperCase();
    langEl.hidden = false;
  } else {
    langEl.hidden = true;
  }

  $("#poster-name-a").textContent = sA;
  $("#poster-name-b").textContent = sB;
  $("#poster-role-a").textContent = manifest.roles?.a || "THE CHALLENGER";
  $("#poster-role-b").textContent = manifest.roles?.b || "THE CONTENDER";
  $("#poster-topic").textContent = manifest.roles?.label
    ? `${manifest.roles.label}: ${b.config.topic}`
    : b.config.topic;
  return true;
};

window.__runDirectorTimeline = async function (manifest) {
  voiceEnabled = false;
  stopAllSpeech();
  document.body.classList.remove("poster-mode");
  document.body.classList.add("cinema-mode", "director-mode");
  const posterEl = $("#poster-stage");
  if (posterEl) posterEl.hidden = true;
  show("battle");
  $("#stop").hidden = true;

  const b = manifest.battle;
  const mInfo = modes.find((x) => x.id === b.config.mode) || {
    id: b.config.mode || "rap",
    name: (b.config.mode || "Rap").toUpperCase(),
    round: "ROUND",
  };
  const stageFighters = b.fighters.map((f) => ({
    ...f,
    name: f.stageName || cleanStageName(f.name),
  }));

  resetStage({
    topic: b.config.topic,
    language: b.config.language,
    mode: mInfo,
    fighters: stageFighters,
  });

  // Show assigned character roles while a corner is waiting on standby so 16:9 has zero dead space
  if (manifest.roles) {
    ["a", "b"].forEach((s) => {
      const roleDesc = manifest.roles[s];
      if (!roleDesc) return;
      const v = $("#side-" + s)?.querySelector(".verse");
      if (v) {
        v.innerHTML = `<div class="standby-role" dir="auto"><span class="standby-kicker">ASSIGNED STANCE</span><p>${esc(roleDesc)}</p></div>`;
      }
    });
  }

  const now = typeof performance !== "undefined" ? () => performance.now() : () => Date.now();
  const t0 = now();
  const waitUntil = (ms) => {
    const delay = Math.max(0, t0 + ms - now());
    return new Promise((r) => setTimeout(r, delay));
  };

  for (const seg of manifest.timeline) {
    await waitUntil(seg.startMs);

    if (seg.type === "intro") {
      $("#round-label").textContent = "MATCHUP INTRO";
      document.body.dataset.spotlight = "both";
      const introPhrases = buildPhraseSchedule(seg.text, seg.words, seg.durationMs);
      for (const ph of introPhrases) {
        if (ph.offsetMs > 0) await waitUntil(seg.startMs + ph.offsetMs);
        updateShortsCaption("RINGSIDE INTRO", ph.captionText, "judge");
      }
      await waitUntil(seg.endMs);
    } else if (seg.type === "verse") {
      const side = $("#side-" + seg.side);
      const other = $("#side-" + (seg.side === "a" ? "b" : "a"));
      document.body.dataset.spotlight = seg.side;
      const rLabel = seg.suddenDeath
        ? "SUDDEN DEATH"
        : `${stageMode.round} ${pad2(seg.round)}`;
      $("#round-label").textContent = rLabel;
      other.classList.remove("active", "speaking");
      side.classList.add("active", "speaking");
      side.querySelector(".performer-status").textContent = "ON THE MIC";

      const v = side.querySelector(".verse");
      v.querySelector(".standby-role")?.remove();
      const block = document.createElement("div");
      block.className = "verse-round";
      block.innerHTML = `<div class="round-head"><span class="round-tag">${esc(rLabel)}</span></div><div class="round-body" dir="auto"><span class="cur"></span></div>`;
      v.appendChild(block);
      v.classList.add("live");

      const cur = block.querySelector(".cur");
      const cleanText = stripInlineMd(seg.text || "");
      const phrases = buildPhraseSchedule(cleanText, seg.words, seg.durationMs);
      const speakerLabel = seg.speaker || stageFighters[seg.side === "a" ? 0 : 1]?.name;

      for (let i = 0; i < phrases.length; i++) {
        const ph = phrases[i];
        if (i > 0 && ph.offsetMs > 0) {
          await waitUntil(seg.startMs + ph.offsetMs);
        }
        cur.innerHTML = `<span class="phrase-past">${ph.pastHtml}</span><span class="phrase-active">${ph.activeHtml}</span>`;
        updateShortsCaption(speakerLabel, ph.captionText, seg.side);
        scrollVerseToBottom(side);
      }

      await waitUntil(seg.endMs);
      cur.textContent = cleanText;
      cur.classList.remove("cur");
      v.classList.remove("live");
      side.classList.remove("active", "speaking");
      side.querySelector(".performer-status").textContent = "TURN COMPLETE";
      scrollVerseToBottom(side);
    } else if (seg.type === "judge") {
      document.body.dataset.spotlight = "both";
      handle({
        type: "round-end",
        round: seg.round,
        scores: seg.scores,
        totals: seg.totals,
      });
      const jPhrases = buildPhraseSchedule(seg.text, seg.words, seg.durationMs);
      for (const ph of jPhrases) {
        if (ph.offsetMs > 0) await waitUntil(seg.startMs + ph.offsetMs);
        updateShortsCaption(
          `JUDGE SCORE: ${seg.scores?.a ?? 0} - ${seg.scores?.b ?? 0}`,
          ph.captionText,
          "judge",
        );
      }
      await waitUntil(seg.endMs);
    } else if (seg.type === "outro") {
      document.body.dataset.spotlight = "both";
      handle({ type: "end", totals: seg.totals || b.totals });
      if (b.final) renderFinal(b.final);
      updateShortsCaption(
        "FINAL VERDICT",
        "WHO WON? DROP 'A' OR 'B' IN COMMENTS!",
        "judge",
      );
      await waitUntil(seg.endMs);
    }
  }

  updateShortsCaption("", "");
  window.__DIRECTOR_DONE__ = true;
  return true;
};
for (const id of ["topic", "rounds", "lines", "language"])
  $("#" + id).addEventListener("input", updateSummary);
$("#topic").addEventListener("input", updateTopicRoles);
$("#shuffle-topic").onclick = () => {
  const next = nextTopic(selectedMode);
  if (!next) return;
  chooseTopic(next.title);
  renderTopicDrops();
  reveal("#topic-drops");
};
function setupError(e) {
  $("#setup-error").textContent =
    e.message || "The arena could not load. Reload to try again.";
  $("#setup-error").hidden = false;
  $("#connection-status").innerHTML = "<i></i> CHECK CONNECTION";
  $("#connection-status").classList.add("offline");
}
loadAdapters().catch(setupError);
loadModes().catch(setupError);
reveal(
  ".lobby-heading, .section-line, .corner-panel, .match-settings, .setup-action-bar",
);
