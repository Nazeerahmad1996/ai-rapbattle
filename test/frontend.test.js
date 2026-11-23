import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { listModes } from "../server/modes.js";

// A small DOM harness exercises asynchronous UI state without invoking AI tools
// or modifying real battle files. Browser layout is verified separately.
const source = readFileSync(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const response = (data) => ({ ok: true, json: async () => data });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

async function arena(route = () => null, reduce = false) {
  const elements = new Map();
  function element(key) {
    if (elements.has(key)) return elements.get(key);
    const classes = new Set();
    const e = {
      value: "",
      textContent: "",
      innerHTML: "",
      hidden: false,
      disabled: false,
      options: [],
      dataset: {},
      style: { setProperty() {} },
      classList: {
        add: (x) => classes.add(x),
        remove: (x) => classes.delete(x),
        contains: (x) => classes.has(x),
        toggle: (x, on) => {
          const active = on ?? !classes.has(x);
          active ? classes.add(x) : classes.delete(x);
          return active;
        },
      },
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      focus() {},
      querySelector: (selector) => element(key + " " + selector),
      appendChild() {},
    };
    elements.set(key, e);
    return e;
  }
  element("#topic").value = "Topic";
  element("#rounds").value = "3";
  element("#lines").value = "8";
  element("#language").value = "English";
  const fighters = [
    {
      id: "codex",
      name: "Codex",
      available: true,
      color: "#fff",
      models: [{ id: "", name: "Default" }],
    },
  ];
  const document = {
    querySelector: element,
    querySelectorAll: (selector) =>
      selector === ".fighter"
        ? [element("#side-a"), element("#side-b")]
        : selector === ".verse"
          ? [element("#side-a .verse"), element("#side-b .verse")]
          : [],
    addEventListener() {},
    body: element("body"),
    createElement: () => element("created-" + elements.size),
  };
  const storage = new Map();
  const motion = { matches: reduce, addEventListener() {} };
  let animationCalls = 0;
  const anime = Object.assign(
    () => {
      animationCalls++;
    },
    { remove() {}, stagger: () => 0, running: [] },
  );
  const context = vm.createContext({
    document,
    matchMedia: () => motion,
    anime,
    window: { anime, scrollTo() {} },
    localStorage: {
      getItem: (k) => storage.get(k),
      setItem: (k, v) => storage.set(k, v),
    },
    fetch: async (url, options) => {
      const custom = route(url, options);
      if (custom) return custom;
      if (url === "/api/adapters") return response(fighters);
      if (url === "/api/modes") return response(listModes());
      throw new Error("No fixture for " + url);
    },
    requestAnimationFrame: (fn) => fn(),
    EventSource: class {
      close() {}
    },
    console,
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  return {
    element,
    storage,
    run: (code) => vm.runInContext(code, context),
    get animationCalls() {
      return animationCalls;
    },
  };
}

test("setup edits cannot unlock a pending launch or submit it twice", async () => {
  const pending = deferred();
  let launches = 0;
  const ui = await arena((url, opts) => {
    if (url === "/api/battles" && opts?.method === "POST") {
      launches++;
      return pending.promise;
    }
  });
  const first = ui.element("#start").onclick();
  ui.element("#topic").value = "Edited while preparing";
  ui.run("updateSummary()");
  assert.equal(ui.element("#start").disabled, true);
  await ui.element("#start").onclick();
  assert.equal(launches, 1);
  pending.resolve({
    ok: false,
    status: 429,
    json: async () => ({ error: "Arena busy" }),
  });
  await first;
  assert.equal(ui.element("#start").disabled, false);
  assert.equal(ui.element("#setup-error").textContent, "Arena busy");
});

test("late votes never overwrite a different battle or lose the original vote receipt", async () => {
  const pending = deferred();
  const ui = await arena((url) =>
    url.endsWith("/vote") ? pending.promise : null,
  );
  ui.run("battleId = 'old'; fighters = [{name:'Old A'},{name:'Old B'}]");
  const vote = ui.element("#vote-a").onclick();
  ui.run("battleId = 'new'; fighters = [{name:'New A'},{name:'New B'}]");
  ui.element("#winner").textContent = "New match winner";
  pending.resolve(
    response({ votes: { a: 1, b: 0 }, final: { a: 12, b: 10, winner: "a" } }),
  );
  await vote;
  assert.equal(ui.element("#winner").textContent, "New match winner");
  assert.equal(ui.storage.get("voted:old"), "a");
  assert.equal(ui.storage.has("voted:new"), false);
});

test("reduced motion skips decorative JavaScript animations", async () => {
  const ui = await arena(undefined, true);
  ui.run("reveal('#view-setup')");
  assert.equal(ui.animationCalls, 0);
});

test("interrupted battles clear the active performer and escape error content", async () => {
  const ui = await arena();
  ui.element("#side-a").classList.add("active");
  ui.run("handle({type:'error',message:'<img src=x onerror=alert(1)>'})");
  assert.equal(ui.element("#side-a").classList.contains("active"), false);
  assert.equal(ui.element("#round-label").textContent, "MATCH INTERRUPTED");
  assert.match(ui.element("#judge-box").innerHTML, /&lt;img/);
  assert.doesNotMatch(ui.element("#judge-box").innerHTML, /<img/);
});

test("topic shuffle exhausts a format before repeating and avoids an immediate repeat at refill", async () => {
  const ui = await arena();
  ui.storage.clear();
  ui.run(
    "topicSeen.clear(); topicDrafts.clear(); $('#topic').value = 'A custom premise';",
  );
  const picked = [];
  for (let i = 0; i < 12; i++) {
    ui.element("#shuffle-topic").onclick();
    picked.push(ui.element("#topic").value);
  }
  assert.equal(new Set(picked).size, 12);
  ui.element("#shuffle-topic").onclick();
  const afterRefill = ui.element("#topic").value;
  assert.notEqual(afterRefill, picked.at(-1));
});

test("reselecting the active format preserves the topic and custom response length", async () => {
  const ui = await arena();
  ui.element("#shuffle-topic").onclick();
  const topic = ui.element("#topic").value;
  ui.element("#lines").value = "12";
  ui.run("selectMode('rap')");
  assert.equal(ui.element("#topic").value, topic);
  assert.equal(ui.element("#lines").value, "12");
});

test("switching formats preserves custom topics; Surprise me intentionally replaces them", async () => {
  const ui = await arena();
  ui.element("#topic").value = "My custom rivalry about two neighbors";
  ui.run("selectMode('debate')");
  assert.equal(
    ui.element("#topic").value,
    "My custom rivalry about two neighbors",
  );
  ui.element("#shuffle-topic").onclick();
  assert.notEqual(
    ui.element("#topic").value,
    "My custom rivalry about two neighbors",
  );
  assert.match(
    ui.element("#topic-roles").textContent,
    /FOR the proposition.*AGAINST the proposition/,
  );
  assert.equal(ui.element("#shuffle-topic").disabled, false);
});
