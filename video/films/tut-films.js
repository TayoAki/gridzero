// Timelines for the tutorial films. Each is one person going from nothing to a result, on real screens.
// Times inside a scene are seconds from that scene's start.

const composer = ".chat-composer textarea";
const sendBtn = ".chat-composer button";
const lastReply = last(".chat-msg.assistant .chat-bubble");
const row = (name) => `[data-testid="def-metric-${name}"]`;
const statusQuestion = closest(byText(".def-question strong, .def-question h3, .def-question *", "Which status values count"), ".def-question");
// The innermost element whose text is exactly this.
const exact = (text) => (el) => [...el.querySelectorAll("*")].find((n) => n.children.length === 0 && n.textContent.trim() === text);
// The page as captured has no scroll position; these put the part being filmed in view.
const scrollTo = (find) => (el) => { const n = typeof find === "function" ? find(el) : el.querySelector(find); if (n) n.scrollIntoView({ block: "center" }); };
const chatEnd = (el) => { const n = el.querySelector(".chat-list"); if (n) n.scrollTop = n.scrollHeight; };
const R = 1740; // roughly the middle of the agent panel, in layout pixels

FILMS.dana = {
  wide: true,
  what: "From an export to a number you can stand behind",
  cta: "Start with the sample data on Home",
  scenes: [
    // Outcome first: the finished report with its confirmed number.
    { kind: "ui", snap: "b6-report", dur: 3.2, cam: [{ t: 0, on: exact("510,535"), s: 2.4, dx: 120, dy: 40 }, { t: 2.6, on: exact("510,535"), s: 2.0, dx: 160, dy: 60 }] },
    { kind: "card", dur: 3.4, lines: [{ text: "From an orders export", at: 0.1 }, { text: "to a number you can stand behind.", at: 0.8, soft: true }] },

    step(1, "Add your data"),
    { kind: "ui", snap: "a0-home", dur: 3.4, cam: [{ t: 0, on: ".home-start", s: 1.25, dy: 60 }, { t: 1.4, on: byText(".home-tile", "Upload a file"), s: 1.9, dx: 180, dy: 40 }], cursor: press(byText(".home-tile", "Upload a file"), 2.5) },
    { kind: "ui", snap: "a1-pick", dur: 1.6, cam: [{ t: 0, on: ".dialog", s: 1.5 }] },
    { kind: "ui", stay: true, snap: "a2-preview", dur: 4.6, cam: [{ t: 0, on: ".dialog", s: 1.5 }, { t: 1.2, on: ".dialog", s: 1.75, dy: -60 }, { t: 2.4, on: ".dialog", s: 1.75, dy: 120 }], cursor: press(".dialog button.primary-inline", 3.7, "bottom", -60) },
    { kind: "ui", snap: "a3-table", dur: 3.6, cam: [{ t: 0, on: ".wb-toolbar", s: 1.15, dy: 380 }, { t: 2.2, on: ".wb-toolbar", s: 1.6, dx: -260, dy: 250 }] },

    step(2, "Ask a question"),
    { kind: "ui", snap: "ask-4", setup: [chatEnd], dur: 3.6, live: [typeInto(composer, "What was revenue by source?", 0.5)], cam: [{ t: 0, on: composer, s: 2.2, dy: -150 }], cursor: press(sendBtn, 2.9, "bottom", 50) },
    { kind: "ui", stay: true, snap: "a5-answer", setup: [chatEnd], dur: 7.4, cam: [{ t: 0, on: lastReply, s: 2.3, dy: -40 }, { t: 3.4, on: lastReply, s: 2.3, dy: -40 }, { t: 4.6, on: lastReply, s: 2.3, dy: 90 }] },

    step(3, "Decide what counts"),
    { kind: "ui", snap: "a6-questions", dur: 5.6, setup: [scrollTo(statusQuestion)], cam: [{ t: 0, on: statusQuestion, s: 1.2 }, { t: 1.6, on: statusQuestion, s: 1.75 }], cursor: press(byText(".def-option", "A"), 4.4, "right", 70) },
    { kind: "ui", stay: true, snap: "a7-answered", dur: 2.6, cam: [{ t: 0, on: ".gz-foot-right", s: 1.9, dx: -200, dy: -200 }] },

    step(4, "Confirm it"),
    { kind: "ui", snap: "a8-count", dur: 4.2, cam: [{ t: 0, on: row("total_gross_sales"), s: 1.9, dx: -40 }], cursor: press(inside(row("total_gross_sales"), "button.primary-inline"), 3.0, "bottom", 60) },
    { kind: "ui", stay: true, snap: "a9-confirmed", dur: 3.4, cam: [{ t: 0, on: row("total_gross_sales"), s: 1.9, dx: -40 }, { t: 1.2, on: row("total_gross_sales"), s: 2.2, dx: -160, dy: -10 }] },

    step(5, "Ask again"),
    { kind: "ui", snap: "ask-10", setup: [chatEnd], dur: 3.6, live: [typeInto(composer, "What was total gross sales?", 0.5)], cam: [{ t: 0, on: composer, s: 2.2, dy: -150 }], cursor: press(sendBtn, 2.9, "bottom", 50) },
    { kind: "ui", stay: true, snap: "b1-confirmed-answer", setup: [chatEnd], dur: 5.2, cam: [{ t: 0, on: lastReply, s: 2.4 }], cursor: press(last(".chat-verify button"), 4.3, "bottom", 50) },
    { kind: "ui", stay: true, snap: "b2-marked", setup: [chatEnd], dur: 2.4, cam: [{ t: 0, on: lastReply, s: 2.4 }] },

    step(6, "Put it on a report"),
    { kind: "ui", snap: "b4-proposal", setup: [chatEnd], dur: 4.0, cam: [{ t: 0, on: byText("button", "Add to dashboard"), s: 2.2, dy: -120 }], cursor: press(byText("button", "Add to dashboard"), 3.0, "bottom", 50) },
    { kind: "ui", snap: "b6-report", dur: 4.4, cam: [{ t: 0, on: exact("510,535"), s: 1.3, dx: 300, dy: 200 }, { t: 1.8, on: exact("510,535"), s: 2.2, dx: 140, dy: 40 }] },
    { kind: "end", dur: 4.0 },
  ],
};

// --- Priya, analytics engineer: a database, scanned and confirmed ---------------------------------
const question = (topic) => closest(byText(".def-question *", topic), ".def-question");
const conflictQ = question("Two ways to work out order count");
const testQ = question("Stores marked test");
// The capture ran against a database on this machine; the film shows a made-up address instead.
const relabel = (el) => {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes("127.0.0.1")) n.nodeValue = n.nodeValue.replaceAll("127.0.0.1", "db.northfield.example");
  el.querySelectorAll("input").forEach((i) => { if (i.value === "127.0.0.1") { i.value = "db.northfield.example"; i.setAttribute("value", i.value); } if (i.value === "5433") { i.value = "5432"; i.setAttribute("value", "5432"); } });
};
const revenueRow = '[data-testid="def-metric-revenue"]';
const nameInput = 'input[name="name"]';

FILMS.priya = {
  wide: true,
  what: "From a database to numbers your company has confirmed",
  cta: "Works with Postgres today",
  scenes: [
    { kind: "ui", snap: "p10-answer", setup: [relabel, chatEnd], dur: 3.4, cam: [{ t: 0, on: lastReply, s: 2.5 }, { t: 2.8, on: lastReply, s: 2.2, dx: -40 }] },
    { kind: "card", dur: 3.4, lines: [{ text: "From a database", at: 0.1 }, { text: "to numbers your company has confirmed.", at: 0.8, soft: true }] },

    step(1, "Connect your database"),
    { kind: "ui", snap: "p0b-named", dur: 3.6, live: [typeInto(nameInput, "Northfield", 0.5, 12)], cam: [{ t: 0, on: nameInput, s: 2.0, dx: 200, dy: -40 }], cursor: press(byText("button", "Create workspace"), 2.8, "right", 60) },
    { kind: "ui", snap: "p1-source", setup: [relabel, scrollTo("form.def-form")], dur: 5.0, cam: [{ t: 0, on: "form.def-form", s: 1.5 }, { t: 1.5, on: "form.def-form", s: 1.8, dy: -80 }, { t: 3.0, on: "form.def-form", s: 1.8, dy: 110 }], cursor: press(byText("button", "Add source"), 4.1, "right", 70) },

    step(2, "Sign in as yourself", "Every query runs with your own access."),
    { kind: "ui", snap: "p2-signin", setup: [relabel, scrollTo(byText("button", "Save my sign-in"))], dur: 4.4, cam: [{ t: 0, on: byText("button", "Save my sign-in"), s: 1.8, dx: 240, dy: -150 }], cursor: press(byText("button", "Save my sign-in"), 3.3, "right", 70) },

    step(3, "Scan"),
    { kind: "ui", snap: "p3-ready", setup: [relabel, scrollTo(byText("button", "Scan"))], dur: 4.0, cam: [{ t: 0, on: byText("button", "Scan"), s: 1.8, dx: 330, dy: -60 }], cursor: press(byText("button", "Scan"), 3.0, "bottom", 60) },
    { kind: "ui", snap: "p4-questions", setup: [relabel], dur: 3.8, cam: [{ t: 0, on: ".def-notice", s: 2.0, dx: -300, dy: 60 }, { t: 2.4, on: ".def-notice", s: 2.0, dx: -300, dy: 60 }, { t: 3.6, on: ".def-notice", s: 1.4, dy: 240 }] },

    step(4, "Settle what the data cannot"),
    { kind: "ui", snap: "p5-conflict", setup: [relabel, scrollTo(conflictQ)], dur: 6.0, cam: [{ t: 0, on: conflictQ, s: 1.3 }, { t: 1.4, on: conflictQ, s: 1.8 }], cursor: press(inside(conflictQ, ".def-option"), 4.8, "right", 70) },
    { kind: "ui", snap: "p6-test-stores", setup: [relabel, scrollTo(testQ)], dur: 6.0, cam: [{ t: 0, on: testQ, s: 1.8 }], cursor: press(inside(testQ, ".def-option"), 4.8, "right", 70) },
    { kind: "ui", stay: true, snap: "p6b-left-out", setup: [relabel], dur: 2.6, cam: [{ t: 0, on: ".def-notice", s: 1.9, dx: -260, dy: 80 }] },

    step(5, "Confirm"),
    { kind: "ui", snap: "p7-count", setup: [relabel, scrollTo(revenueRow)], dur: 4.2, cam: [{ t: 0, on: revenueRow, s: 1.9, dx: -40 }], cursor: press(inside(revenueRow, "button.primary-inline"), 3.0, "bottom", 60) },
    { kind: "ui", stay: true, snap: "p8-confirmed", setup: [relabel, scrollTo(revenueRow)], dur: 3.6, cam: [{ t: 0, on: revenueRow, s: 1.9, dx: -40 }, { t: 1.2, on: revenueRow, s: 2.2, dx: -160 }] },

    step(6, "Ask"),
    { kind: "ui", snap: "p9-ask", setup: [relabel, chatEnd], dur: 3.4, live: [typeInto(composer, "What is revenue?", 0.5)], cam: [{ t: 0, on: composer, s: 2.2, dy: -150 }], cursor: press(sendBtn, 2.6, "bottom", 50) },
    { kind: "ui", stay: true, snap: "p10-answer", setup: [relabel, chatEnd], dur: 5.4, cam: [{ t: 0, on: lastReply, s: 2.4 }] },
    { kind: "end", dur: 4.0 },
  ],
};
