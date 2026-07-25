"use strict";

/**
 * Static checks on the ExtendScript host layer (src/host/*.jsx).
 *
 * This code runs inside Premiere's ExtendScript engine — ES3 with only patches of
 * ES5 — not in Node and not in the CEF panel. There is no way to unit-test it
 * outside Premiere, and a single `const` or arrow function makes the whole file fail
 * to parse, at which point EVERY ISTV call throws and the panel is dead on arrival.
 * A syntax slip is therefore both the likeliest and the most expensive failure, so
 * it gets caught here instead of on an editor's machine.
 *
 * These are the same checks a reviewer would do by eye, made mechanical.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");

const HOST_DIR = path.join(__dirname, "..", "src", "host");
// json2.js is vendored (it IS the ES5 JSON polyfill) so it is not ours to lint.
const OUR_FILES = ["host.jsx", "captions.jsx"];

/**
 * Blank out comments, string literals, and REGEX literals, leaving code structure.
 *
 * A naive regex-based stripper is not good enough here: host.jsx contains
 * `/[\\\/:*?"<>|]/g`, whose embedded `"` opens a phantom string literal that
 * swallows real code — which silently corrupts every check downstream. So this is a
 * small character scanner instead. Regex-vs-division is disambiguated by the last
 * significant character, the standard heuristic.
 */
function codeOnly(src) {
  let out = "";
  let i = 0;
  let lastSignificant = "";
  const regexCanStart = () => lastSignificant === "" || "(,=:[!&|?{};+-*%~^<>".includes(lastSignificant);

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i++;
      out += c + c; // an empty literal keeps expression shape intact
      lastSignificant = c;
      continue;
    }
    if (c === "/" && regexCanStart()) {
      i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
        else if (src[i] === "\n") break; // unterminated: bail rather than run away
        i++;
      }
      i++;
      while (i < src.length && /[a-z]/.test(src[i])) i++; // flags
      out += "RE";
      lastSignificant = "E";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out;
}

const sources = OUR_FILES.map((name) => ({
  name,
  raw: fs.readFileSync(path.join(HOST_DIR, name), "utf8"),
  code: codeOnly(fs.readFileSync(path.join(HOST_DIR, name), "utf8")),
}));

test("host files exist where the manifest and loader expect them", () => {
  for (const name of [...OUR_FILES, "json2.js"]) {
    assert.ok(fs.existsSync(path.join(HOST_DIR, name)), `src/host/${name} is missing`);
  }
  // The manifest's ScriptPath must point at a file that is really there.
  const manifest = fs.readFileSync(path.join(__dirname, "..", "CSXS", "manifest.xml"), "utf8");
  const script = /<ScriptPath>\s*\.\/(.+?)\s*<\/ScriptPath>/.exec(manifest);
  assert.ok(script, "manifest has no ScriptPath");
  assert.ok(fs.existsSync(path.join(__dirname, "..", script[1])), `ScriptPath ${script[1]} does not exist`);
});

test("no ES5+ syntax that ExtendScript cannot parse", () => {
  // Each of these is a hard parse error in ExtendScript, not a runtime problem: one
  // occurrence takes the entire file — and therefore the whole panel — down.
  const banned = [
    [/\b(?:const|let)\s+[A-Za-z_$]/, "const/let (use var)"],
    [/=>/, "arrow function"],
    [/`/, "template literal"],
    [/\.\.\./, "spread/rest"],
    [/\bclass\s+[A-Za-z_$]/, "class declaration"],
    [/\basync\s+function\b|\bawait\s/, "async/await"],
    [/\bfunction\s*\*/, "generator"],
    [/\?\./, "optional chaining"],
    [/\?\?/, "nullish coalescing"],
    [/\{\s*[A-Za-z_$][\w$]*\s*(?:,|\}\s*=)/, "destructuring assignment"],
  ];
  for (const { name, code } of sources) {
    for (const [re, label] of banned) {
      const m = re.exec(code);
      assert.equal(m, null, `${name}: ${label} is not supported by ExtendScript (found "${m && m[0]}")`);
    }
  }
});

test("no ES5 library calls that ExtendScript's older engines lack", () => {
  // These parse fine but are undefined at runtime on the Premiere builds in the
  // manifest's supported range, so they fail only once a real editor runs them.
  const banned = [
    [/\bArray\.isArray\b/, "Array.isArray"],
    [/\.forEach\s*\(/, ".forEach (use an indexed for loop)"],
    [/\.(?:map|filter|reduce|some|every|find|findIndex|includes)\s*\(/, "Array iteration method"],
    [/\.trim\s*\(\s*\)/, "String.trim"],
    [/\.padStart\s*\(|\.padEnd\s*\(/, "String.padStart/padEnd"],
    [/\bObject\.(?:keys|assign|entries|values)\b/, "Object.keys/assign/entries/values"],
    [/\bJSON\.parse\b(?![\s\S]{0,0})/, null], // JSON is polyfilled by json2.js — allowed
  ];
  for (const { name, code } of sources) {
    for (const [re, label] of banned) {
      if (!label) continue;
      const m = re.exec(code);
      assert.equal(m, null, `${name}: ${label} is unavailable in ExtendScript (found "${m && m[0]}")`);
    }
  }
});

test("each host file parses as valid JavaScript", () => {
  // ES3 is a subset of what V8 accepts, so if V8 can't parse it, ExtendScript
  // certainly can't. ExtendScript's own parse errors are famously unhelpful and only
  // appear inside Premiere, so catching a bad edit here saves a real debug session.
  // The `ISTV = ...` implicit globals need sloppy mode, hence the wrapper.
  for (const { name, raw } of sources) {
    assert.doesNotThrow(
      () => new vm.Script(raw, { filename: name }),
      (e) => new Error(`${name} does not parse: ${e.message}`)
    );
  }
});

test("braces, parens, and brackets balance in the scanned code", () => {
  // A second, independent structural check — and a self-test of codeOnly(), whose
  // correctness the banned-construct scans depend on.
  for (const { name, code } of sources) {
    for (const [open, close] of [["{", "}"], ["(", ")"], ["[", "]"]]) {
      const count = (ch) => code.split(ch).length - 1;
      assert.equal(count(open), count(close), `${name}: unbalanced ${open}${close}`);
    }
  }
});

test("codeOnly strips regex literals containing quotes", () => {
  // The exact shape that broke the naive stripper: the `"` inside the character
  // class must not be read as the start of a string.
  const stripped = codeOnly('var a = s.replace(/[\\\\\\/:*?"<>|]/g, ""); var b = { x: 1 };');
  assert.ok(!stripped.includes("<>"), "the regex body is gone");
  assert.equal(stripped.split("{").length - 1, 1, "the object literal survives");
  assert.equal(stripped.split("}").length - 1, 1);
  assert.ok(!stripped.includes("//"), "division after a value is not mistaken for a comment");
});

test("the host exposes exactly the entry points the panel calls", () => {
  const host = sources.find((s) => s.name === "host.jsx").raw;
  // panel.js calls these by name; a rename on one side only is a silent breakage.
  for (const fn of ["ping", "getActiveSource", "buildReels", "attachProxy"]) {
    assert.match(host, new RegExp(`\\b${fn}\\s*:\\s*${fn}\\b`), `host.jsx must export ${fn}`);
  }
  const panel = fs.readFileSync(path.join(__dirname, "..", "src", "panel", "panel.js"), "utf8");
  for (const call of [...panel.matchAll(/hostCall\(\s*"([A-Za-z_$][\w$]*)"/g)].map((m) => m[1])) {
    assert.match(host, new RegExp(`\\b${call}\\s*:\\s*${call}\\b`), `panel calls ISTV.${call} but host.jsx does not export it`);
  }
});

test("host globals are declared implicitly so $.evalFile scoping works", () => {
  // `var ISTV = ...` would keep the object local to the scope $.evalFile runs in,
  // and host.jsx would then see "ISTV_Captions is undefined". This is deliberate.
  const host = sources.find((s) => s.name === "host.jsx").raw;
  const caps = sources.find((s) => s.name === "captions.jsx").raw;
  assert.match(host, /^ISTV\s*=\s*\(function/m);
  assert.match(caps, /^ISTV_Captions\s*=\s*\(function/m);
  assert.ok(!/^var\s+ISTV\s*=/m.test(host), "ISTV must not be declared with var");
  assert.ok(!/^var\s+ISTV_Captions\s*=/m.test(caps), "ISTV_Captions must not be declared with var");
});

test("every host entry point returns a JSON envelope the panel can parse", () => {
  // panel.js JSON.parses whatever comes back; a bare return would surface as
  // "Bad host response". Both helpers must stringify.
  const host = sources.find((s) => s.name === "host.jsx").raw;
  assert.match(host, /function ok\([\s\S]{0,200}JSON\.stringify/);
  assert.match(host, /function err\([\s\S]{0,200}JSON\.stringify/);
});

test("the panel loads the host files in dependency order", () => {
  // json2.js first (it provides JSON), then captions.jsx (ISTV_Captions), then
  // host.jsx, which uses both at call time.
  const panel = fs.readFileSync(path.join(__dirname, "..", "src", "panel", "panel.js"), "utf8");
  const list = /\[\s*"json2\.js"\s*,\s*"captions\.jsx"\s*,\s*"host\.jsx"\s*\]/.exec(panel);
  assert.ok(list, "panel.js must load json2.js, captions.jsx, host.jsx in that order");
  assert.match(panel, /"src", "host"/, "the loader must point at src/host after the restructure");
});
