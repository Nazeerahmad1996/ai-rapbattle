import { TOPICS } from "./topics.js";

// Battle modes. Each mode defines how a turn is prompted and how the judge scores it.
// To add a mode, add an entry here — the UI and server pick it up automatically.
export const MODES = {
  rap: {
    name: "Rap Battle",
    emoji: "🎤",
    turn: "verse",
    round: "ROUND",
    topic: TOPICS.rap[0].title,
    unit: "lines",
    lengthLabel: "Lines / verse",
    length: 8,
    role: "an MC in a 1v1 rap battle",
    task: (n) =>
      `Write exactly ${n} newline-separated rap bars for a 90 BPM performance. Aim for roughly 10–16 syllables per bar, one clear breath and 3–4 strong stresses; keep neighboring bars close in length. Avoid prose-length compound sentences. Put the rhyme or decisive word at the end of the bar, with internal rhyme where it sounds effortless. Use natural rhythm, fresh rhyme choices, vivid everyday details and specific attacks on the rival's position. Make the punchlines understandable on one listen; never force a rhyme at the expense of meaning.`,
    criteria:
      "topic-specific punchlines, fresh angles, natural flow and rhyme, and effective responses to the actual opponent",
    judgeRole: "a fair, sharp hip-hop battle judge",
  },
  roast: {
    name: "Roast Battle",
    emoji: "🔥",
    turn: "roast",
    round: "ROUND",
    topic: TOPICS.roast[0].title,
    unit: "sentences",
    lengthLabel: "Sentences / roast",
    length: 4,
    role: "a comedian in a 1v1 roast battle",
    task: (n) =>
      `Deliver about ${n} sentences of sharp roast comedy. Expose a recognizable contradiction in the rival's behavior with concrete details and surprising comic turns. Sound like a quick-witted person talking, not a list of interchangeable insults. Rhyme only if it genuinely helps the joke.`,
    criteria:
      "specificity, fresh comic premises, surprise, timing, and how well the burns fit the fictional rivalry",
    judgeRole: "a stand-up comedy judge",
  },
  debate: {
    name: "Debate",
    emoji: "⚖️",
    turn: "argument",
    round: "ROUND",
    topic: TOPICS.debate[0].title,
    unit: "sentences",
    lengthLabel: "Sentences / argument",
    length: 5,
    role: "a competitive debater",
    task: (n) =>
      `Make a punchy argument in about ${n} sentences. Use a clear claim, relatable reasoning and specific everyday examples. Engage the strongest relevant point your rival made, but choose your own structure and where the rebuttal lands. No invented statistics, studies, quotes or allegations. The first speaker argues FOR the topic and the second speaker argues AGAINST it.`,
    criteria:
      "clear reasoning, credible examples, engagement with the strongest opposing point, and persuasive originality rather than volume",
    judgeRole: "a neutral debate adjudicator",
  },
  poetry: {
    name: "Poetry Slam",
    emoji: "🪶",
    turn: "poem",
    round: "ROUND",
    topic: TOPICS.poetry[0].title,
    unit: "lines",
    lengthLabel: "Lines / poem",
    length: 8,
    role: "a poet in a head-to-head poetry slam",
    task: (n) =>
      `Write exactly ${n} lines of spoken-word poetry. Find specific sensory details and an earned emotional turn; avoid vague inspirational statements. Offer a new emotional perspective. You may transform your rival's image, but do not copy their situation or escalate mechanically into a greater tragedy. Rhyme is optional.`,
    criteria:
      "concrete imagery, fresh perspective, emotional honesty, and language that earns its impact",
    judgeRole: "a poetry slam judge",
  },
  story: {
    name: "Story Duel",
    emoji: "📖",
    turn: "passage",
    round: "CHAPTER",
    topic: TOPICS.story[0].title,
    unit: "sentences",
    lengthLabel: "Sentences / passage",
    length: 6,
    role: "a storyteller in a collaborative-yet-competitive story duel",
    task: (n) =>
      `Write about ${n} sentences of the shared fictional story. Start in the scene if no passage exists; otherwise continue the last action with the same characters, facts and point of view. Make a choice have a consequence. Suspense can come from dialogue, a reveal or a hard decision; do not insert a random twist, new villain, dream reset or cliffhanger every turn.`,
    criteria:
      "character choices, believable consequences, continuity, fresh scene details and narrative momentum",
    judgeRole: "a fiction editor",
  },
};

export const LANGUAGES = {
  English: { name: "English", instruction: "" },
  Hindi: {
    name: "Hindi (हिन्दी)",
    instruction:
      "Write strictly in Hindi (Devanagari script) with authentic vocabulary, idioms, and rhyme.",
  },
  Hinglish: {
    name: "Hinglish (Hindi + English)",
    instruction:
      "Write strictly in Hinglish (a natural Desi mix of Hindi and English written in Latin/Roman script, like Indian gully rap and roast battles).",
  },
  Urdu: {
    name: "Urdu (اردو)",
    instruction:
      "Write strictly in Urdu (Nastaliq/Arabic script) with sharp Urdu vocabulary, poetic punchlines, and rhythm.",
  },
  "Roman Urdu": {
    name: "Roman Urdu",
    instruction:
      "Write strictly in Roman Urdu (Urdu written in the Latin/English alphabet, with authentic Urdu slang, punchlines, and flow).",
  },
  Punjabi: {
    name: "Punjabi (ਪੰਜਾਬੀ / Roman)",
    instruction:
      "Write strictly in Punjabi with authentic Punjabi flow, idioms, and energy.",
  },
  Spanish: {
    name: "Spanish (Español)",
    instruction:
      "Write strictly in Spanish with authentic slang, rhythm, and wordplay.",
  },
  French: {
    name: "French (Français)",
    instruction:
      "Write strictly in French with authentic slang, rhythm, and wordplay.",
  },
  German: {
    name: "German (Deutsch)",
    instruction: "Write strictly in German with authentic rhythm and wordplay.",
  },
  Portuguese: {
    name: "Portuguese (Português)",
    instruction:
      "Write strictly in Portuguese with authentic rhythm and wordplay.",
  },
  Arabic: {
    name: "Arabic (العربية)",
    instruction:
      "Write strictly in Arabic with strong rhythm, eloquence, and wordplay.",
  },
  Russian: {
    name: "Russian (Русский)",
    instruction: "Write strictly in Russian with sharp rhythm and wordplay.",
  },
  Turkish: {
    name: "Turkish (Türkçe)",
    instruction: "Write strictly in Turkish with sharp rhythm and wordplay.",
  },
  Japanese: {
    name: "Japanese (日本語)",
    instruction: "Write strictly in Japanese with natural rhythm and wordplay.",
  },
  Korean: {
    name: "Korean (한국어)",
    instruction: "Write strictly in Korean with natural rhythm and wordplay.",
  },
  Chinese: {
    name: "Chinese (中文)",
    instruction: "Write strictly in Chinese with sharp rhythm and wordplay.",
  },
};

export function languageInstruction(lang) {
  if (!lang || lang === "English") return "";
  return LANGUAGES[lang]?.instruction ?? `Write strictly in ${lang}.`;
}

export const DEFAULT_MODE = "rap";
export function getMode(id) {
  return Object.hasOwn(MODES, id) ? MODES[id] : MODES[DEFAULT_MODE];
}
export function listModes() {
  return Object.entries(MODES).map(([id, m]) => ({
    id,
    name: m.name,
    emoji: m.emoji,
    topic: m.topic,
    topics: TOPICS[id],
    lengthLabel: m.lengthLabel,
    length: m.length,
    round: m.round,
  }));
}
