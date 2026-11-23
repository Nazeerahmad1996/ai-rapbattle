import { randomInt } from "node:crypto";

const VOICES = {
  rap: [
    "relaxed confidence: conversational timing and deceptively sharp punchlines",
    "playful troublemaker: mischievous observations and nimble rhyme switches",
    "controlled fury: spare, precise lines with pressure behind every word",
    "street-corner storyteller: tiny recognizable scenes with comic payoffs",
    "deadpan show-off: understated delivery that makes an absurd comparison land",
    "theatrical charmer: swagger, expressive rhythm and a surprising vulnerability",
    "quick-witted underdog: resourcefulness, cheek and an eye for hypocrisy",
    "smooth satirist: polished delivery that makes the rival expose themselves",
  ],
  roast: [
    "dry deadpan: say the devastating observation as if it is perfectly ordinary",
    "playful best friend: affectionate familiarity with absolutely merciless receipts",
    "exhausted realist: make the ridiculous behavior sound painfully recognizable",
    "charming menace: warm delivery, cold precision and a wicked little surprise",
    "animated observer: a tiny scene that exposes a big contradiction",
    "calm cross-examiner: simple questions that make the rival incriminate themselves",
    "self-aware troublemaker: admit one flaw and turn it into the rival's problem",
    "unimpressed outsider: cut through the pretence with plain, economical language",
  ],
  debate: [
    "practical skeptic: test grand claims against what happens in everyday life",
    "empathetic challenger: take the human cost seriously and expose a blind spot",
    "calm contrarian: challenge an assumption without becoming smug",
    "plainspoken realist: concrete tradeoffs and a memorable clear conclusion",
    "sharp questioner: focus on a contradiction the rival must explain",
    "principled storyteller: one plausible example that reveals the larger issue",
    "measured advocate: concede a fair point, then draw a decisive distinction",
    "witty analyst: conversational logic with one incisive comic observation",
  ],
  poetry: [
    "intimate observer: ordinary objects carry the emotion without explanation",
    "restrained confessor: let what remains unsaid do some of the work",
    "defiant survivor: dignity and tension without motivational slogans",
    "warm realist: tenderness alongside an uncomfortable concrete truth",
    "wry witness: a small flash of humor makes the hurt more human",
    "sensory storyteller: texture, sound and gesture before abstract emotion",
    "quiet challenger: complicate the easy interpretation without dismissing the feeling",
    "clear-eyed dreamer: vivid imagery rooted in a real place and a particular moment",
  ],
  story: [
    "character-led suspense: decisions and small gestures reveal the tension",
    "darkly comic realism: social embarrassment with real consequences",
    "lean cinematic prose: precise action, economical dialogue, concrete surroundings",
    "intimate drama: motives and subtext matter as much as the reveal",
    "quiet suspense: make one ordinary detail become newly significant",
    "social satire: let status and hypocrisy drive believable choices",
    "compassionate tension: people want understandable things that cannot all coexist",
    "sharp dialogue: distinctive voices and an action that changes the relationship",
  ],
};

const MOVES = {
  rap: [
    "Find an overlooked everyday detail and make it the attack.",
    "Flip one specific image from the rival into a fresh meaning, if available.",
    "Build a tiny scene that exposes the gap between the rival's image and reality.",
    "Let one surprising comparison carry the punch; avoid stacking unrelated metaphors.",
    "Use understatement where the rival expects a loud boast.",
    "Take an unexpected angle on the topic that the battle has not used yet.",
    "Show the consequence of the rival's attitude instead of naming the flaw.",
    "Find a contradiction and let the rival's own logic do the damage.",
    "Briefly concede something, then turn that apparent advantage inside out.",
    "Change the rhyme sound and sentence shape from your previous verse.",
    "Make the concrete detail funnier or sharper than the big claim.",
    "Choose your own fresh approach; surprise the audience without changing the subject.",
  ],
  roast: [
    "Turn an ordinary habit into an unexpectedly revealing observation.",
    "Expose the mismatch between what the rival says and what they do.",
    "Let a short imagined scene demonstrate why their excuse falls apart.",
    "Use an absurd but recognizable comparison rather than a generic insult.",
    "Question one detail so precisely that the excuse becomes the punchline.",
    "Understate the situation and let the audience connect the dots.",
    "Turn a boast into evidence for the prosecution.",
    "Find the embarrassing practical consequence nobody has mentioned.",
    "Use a self-own as a trap rather than pretending you are flawless.",
    "Answer one specific burn with a new comic premise, not just its reversed wording.",
    "Change the sentence rhythm; leave a little space for the punchline.",
    "Follow the funniest unused angle on the topic; choose the structure freely.",
  ],
  debate: [
    "Test the claim in one plausible everyday situation.",
    "Identify a hidden assumption and explain why it matters.",
    "Separate two things the rival is treating as identical.",
    "Acknowledge a fair objection, then show where your position still holds.",
    "Ask a pointed question and explain what its answer reveals.",
    "Trace one practical consequence beyond the obvious first step.",
    "Use a counterexample that challenges the scope of the claim.",
    "Show who carries the cost when the rival's rule is applied.",
    "Clarify a principle without turning it into a slogan.",
    "Compare the realistic alternatives rather than your ideal with their worst case.",
    "Stress-test the strongest point actually made, not a weaker invented position.",
    "Choose a fresh line of reasoning; avoid repeating the debate's existing examples.",
  ],
  poetry: [
    "Let an ordinary object carry a feeling without naming the feeling.",
    "Find a sensory detail the earlier poems have not touched.",
    "Change the emotional interpretation rather than intensifying the same sadness.",
    "Put tension between what is spoken and what a small gesture reveals.",
    "Let a concrete memory interrupt the present moment.",
    "Find an unexpected trace of tenderness or humor that fits the topic.",
    "Use the distance between two people as something physically observable.",
    "Stay with one place; let a tiny change alter what it means.",
    "Let a question remain unresolved instead of explaining the lesson.",
    "Revisit a prior image only if you transform its meaning.",
    "Change line lengths or sentence rhythm while keeping the requested line count.",
    "Choose an unused emotional angle and let the poem discover its own shape.",
  ],
  story: [
    "Let the last action produce a believable immediate consequence.",
    "Reveal motive through a choice rather than an explanatory monologue.",
    "Use dialogue with subtext while continuing the established scene.",
    "Make an existing object or detail newly relevant.",
    "Give a character a difficult choice with a cost on both sides.",
    "Let an attempted solution create a plausible complication.",
    "Allow a quiet reaction to change the power balance.",
    "Pay off an established detail instead of adding another mystery.",
    "Resolve a small tension and make its consequence matter.",
    "Show a character acting against what they claimed to want.",
    "Advance the immediate action without a location jump or recap.",
    "Choose the next honest consequence; the story does not owe a twist every turn.",
  ],
};

function shuffled(values, pick) {
  const deck = [...values];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Voices stay stable; turn approaches differ across both sides and all 1–5 rounds.
// Injecting pick makes constraints testable without probabilistic assertions.
export function createPerformancePlan(
  mode = "rap",
  rounds = 3,
  pick = randomInt,
) {
  const voices = shuffled(VOICES[mode] ?? VOICES.rap, pick);
  const moves = shuffled(MOVES[mode] ?? MOVES.rap, pick);
  const count = Math.max(1, Math.min(5, rounds));
  return {
    voices: { a: voices[0], b: voices[1] },
    moves: {
      a: moves.slice(0, count),
      b: moves.slice(count, count * 2),
    },
  };
}
