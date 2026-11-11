# Builds tut.html (the tutorial film page) from film.html, and points render.mjs at the tutorial data.
import os

here = os.path.dirname(os.path.abspath(__file__))
s = open(os.path.join(here, "film.html")).read()
head = s[: s.index("const FILMS = {")]

swaps = [
    ('  shell.classList.add("no-side", "no-right");\n', ""),
    ("const ZOOM = 1.3;", "const ZOOM = 1;"),
    ('  tag.style.display = sc.kind === "ui" ? "block" : "none";', '  tag.style.display = "none";'),
    (
        "    const applied = (sc.edits || []).map((e, i) => (t >= e.t ? i : -1)).filter((i) => i >= 0);",
        "    const rt = t - sc.t0;\n    const applied = (sc.edits || []).map((e, i) => (rt >= e.t ? i : -1)).filter((i) => i >= 0);",
    ),
    ("    const m = applyCam(A, camAt(sc, t, A));", "    const m = applyCam(A, camAt(sc, rt, A));"),
    ("      applyCam(B, camAt(prev, prev.t1 - 1 / FPS, B));", "      applyCam(B, camAt(prev, prev.t1 - prev.t0, B));"),
    (
        "    const mv = (sc.cursor || []).find((c) => t >= c.t0 && t <= c.t2);\n    if (mv) {",
        "    const mv0 = (sc.cursor || []).find((c) => rt >= c.t0 && rt <= c.t2);\n    if (mv0) {\n      const mv = mv0; const t = rt;",
    ),
    (
        "    if (box.dataset.key !== key) { box.dataset.key = key; box.innerHTML = sc.lines.map",
        '    if (box.dataset.key !== key) { box.dataset.key = key; box.innerHTML = (sc.step ? `<div class="step">Step ${sc.step}</div>` : "") + sc.lines.map',
    ),
    ("    [...box.children].forEach((n, i) => {", '    [...box.querySelectorAll(".line")].forEach((n, i) => {'),
    (
        "  #card .line.soft { color: #6ea8ff; }",
        "  #card .line.soft { color: #6ea8ff; }\n  #card .step { font-size: 34px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #f0c060; }",
    ),
    (
        '$(".lock", end).style.opacity = a;',
        '$(".when", end).textContent = FILM.cta || ""; $(".when", end).style.display = FILM.cta ? "block" : "none"; $(".lock", end).style.opacity = a;',
    ),
]
for old, new in swaps:
    assert old in head, old[:60]
    head = head.replace(old, new)

tail = """
// Text arriving in a field at a human rate.
const typeInto = (sel, text, start, cps = 16) => (el, dt) => { const n = el.querySelector(sel); if (!n) return; const k = Math.max(0, Math.min(text.length, Math.floor((dt - start) * cps))); n.textContent = text.slice(0, k); n.value = text.slice(0, k); };
const inside = (outer, sel) => (el) => { const o = typeof outer === "function" ? outer(el) : el.querySelector(outer); return o && o.querySelector(sel); };
const closest = (find, sel) => (el) => { const n = find(el); return n && n.closest(sel); };
const last = (sel) => (el) => { const all = el.querySelectorAll(sel); return all[all.length - 1]; };
// Scenes are written with lengths; this lays them end to end.
function seq(list) { let t = 0; return list.map((s, i) => { const o = { ...s, id: s.id || "s" + i, t0: t, t1: t + s.dur }; t += s.dur; return o; }); }
const step = (n, a, b) => ({ kind: "card", dur: 2.3, step: n, lines: [{ text: a, at: 0.1 }, ...(b ? [{ text: b, at: 0.6, soft: true }] : [])] });
const press = (to, at, from = "right", bow = 80) => [{ t0: at - 1.3, t1: at - 0.25, t2: at + 1.0, from, to, press: at, bow }];
const FILMS = (window.FILMS = {});
window.init = function (data, name) { SNAPS = data.snaps; $("#app-css").textContent = data.css; FILM = FILMS[name]; FILM.scenes = seq(FILM.scenes); return Math.round(FILM.scenes[FILM.scenes.length - 1].t1 * FPS); };
</script>
<script src="tut-films.js"></script>
"""
open(os.path.join(here, "tut.html"), "w").write(head + tail)

r = open(os.path.join(here, "render.mjs")).read()
if "const TUT" not in r:
    r = r.replace(
        'const data = JSON.parse(readFileSync(dir + "snap/snaps.json", "utf8"));',
        'const TUT = { dana: "tut/v1.json", priya: "tut/v2.json" };\nconst data = JSON.parse(readFileSync(dir + (TUT[name] ?? "snap/snaps.json"), "utf8"));',
    )
    r = r.replace('await page.goto("file://" + dir + "film.html");', 'await page.goto("file://" + dir + (TUT[name] ? "tut.html" : "film.html"));')
    open(os.path.join(here, "render.mjs"), "w").write(r)
print("ok", len(head))
