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

// ====================================================================================================
// The pain-point films (November 2026). Real screens from the current build; the agent's wording in the
// second film is from a scripted stand-in model. Card copy: the tension lines follow the Bob Speak mode
// (the comfortable assumption, then what happens in practice); the step lines follow the Ina Koleva mode
// (what we do next, in order, with the same test before and after).
// ====================================================================================================
const askInput = ".gz-ask input";
const askGo = ".gz-ask-go";
const panelReply = last(".gz-right .chat-msg.assistant .chat-bubble");
const panelEnd = (el) => { const n = el.querySelector(".gz-right .chat-list"); if (n) n.scrollTop = n.scrollHeight; };
const firstQ = (el) => el.querySelector("[data-testid=need-question]");
const card = (title) => closest(byText(".widget-title", title), ".widget-card");
// The client's list shows the report twice after a second capture; the film keeps one.
// The capture ran on this machine; the film shows a made-up address instead of localhost.
const fakeHost = (el) => el.querySelectorAll("input").forEach((i) => { if (/localhost:\d+/.test(i.value)) { i.value = i.value.replace(/https?:\/\/localhost:\d+/, "https://app.gridzero.example"); i.setAttribute("value", i.value); } });
const oneReport = (el) => [...el.querySelectorAll(".gz-side-row")].filter((r) => !r.querySelector(".on") && /Monthly client report/.test(r.textContent)).forEach((r) => r.remove());

// --- Dana, agency reporting lead: one report for every client -------------------------------------
FILMS.agency2 = {
  wide: true,
  what: "One report. Every client. Each sees only their own.",
  cta: "In review. Not yet released.",
  scenes: [
    // The outcome first: what one client sees.
    { kind: "ui", snap: "e0-client", setup: [oneReport], stay: true, dur: 3.6, cam: [{ t: 0, on: ".slice-bar", s: 1.6, dy: 150 }, { t: 2.2, on: exact("32,550"), s: 2.4, dx: 160, dy: 20 }] },
    { kind: "card", dur: 3.6, lines: [{ text: "A report for every client", at: 0.1 }, { text: "usually means a copy for every client.", at: 1.0, soft: true }] },
    { kind: "card", dur: 3.2, lines: [{ text: "Copies drift.", at: 0.1 }, { text: "One of them is always wrong.", at: 0.9, soft: true }] },
    { kind: "card", dur: 2.8, lines: [{ text: "Build it once.", at: 0.1 }, { text: "Here is how, from an empty account.", at: 0.8, soft: true }] },

    step(1, "Add the orders", "one file, every client in it"),
    { kind: "ui", snap: "a0-home", dur: 3.0, cam: [{ t: 0, on: byText(".home-tile", "Upload a file"), s: 1.9, dx: 180, dy: 40 }], cursor: press(byText(".home-tile", "Upload a file"), 2.0) },
    { kind: "ui", stay: true, snap: "a2-preview", dur: 3.8, cam: [{ t: 0, on: ".dialog", s: 1.5 }, { t: 1.4, on: ".dialog", s: 1.75, dy: 120 }], cursor: press(".dialog button.primary-inline", 2.9, "bottom", -60) },
    { kind: "ui", snap: "a3-table", dur: 2.6, cam: [{ t: 0, on: ".wb-toolbar", s: 1.5, dx: -200, dy: 260 }] },

    step(2, "Build the report yourself", "no analyst, no waiting"),
    { kind: "ui", snap: "b0-empty", dur: 2.8, cam: [{ t: 0, on: byText("button", "Add a card from a table"), s: 1.9, dy: -60 }], cursor: press(byText("button", "Add a card from a table"), 1.9, "bottom", 50) },
    { kind: "ui", stay: true, snap: "b1-builder", dur: 3.6, cam: [{ t: 0, on: ".builder-dialog", s: 1.45 }, { t: 1.6, on: ".builder-preview", s: 1.9, dx: -60 }] },
    { kind: "ui", stay: true, snap: "b2-split", dur: 4.4, cam: [{ t: 0, on: ".builder-form", s: 1.9, dx: 120 }, { t: 2.0, on: ".builder-preview", s: 1.8, dx: -60 }], cursor: press(byText(".builder-dialog button", "Add to report"), 3.5, "bottom", 50) },
    { kind: "ui", snap: "c0-report", dur: 3.0, cam: [{ t: 0, on: card("Total amount by client"), s: 1.5, dx: -160, dy: 60 }] },

    step(3, "Know what you are looking at", "a filter says whether it reached the card"),
    { kind: "ui", snap: "c1-filtered", dur: 6.4, cam: [{ t: 0, on: ".filter-dates", s: 2.2, dx: 120, dy: 60 }, { t: 2.2, on: ".filter-dates", s: 2.2, dx: 120, dy: 60 }, { t: 3.4, on: exact("12,229"), s: 2.5, dx: 120, dy: 30 }] },

    step(4, "Share it once", "and hold each person to their rows"),
    { kind: "ui", snap: "d0-share", dur: 3.6, live: [typeInto('.report-dialog input[type="email"]', "bea@birchwood.example", 0.4, 14)], cam: [{ t: 0, on: ".report-dialog", s: 1.8 }], cursor: press(byText(".report-dialog button", "Invite"), 2.8, "bottom", 50) },
    { kind: "ui", stay: true, snap: "d2-invited", setup: [fakeHost], dur: 3.2, cam: [{ t: 0, on: ".report-dialog", s: 1.8 }], cursor: press(byText(".report-dialog button", "Limit what they see"), 2.2, "bottom", 50) },
    { kind: "ui", stay: true, snap: "d3-limit", setup: [fakeHost], dur: 3.8, cam: [{ t: 0, on: ".report-limit-form", s: 2.4, dx: -40 }], cursor: press(byText(".report-limit-form button", "Apply"), 2.8, "bottom", 50) },
    { kind: "ui", stay: true, snap: "d4-limited", setup: [fakeHost], dur: 3.0, cam: [{ t: 0, on: ".report-limit", s: 2.6, dx: -40 }] },

    step(5, "What the client gets", "their rows, their totals"),
    { kind: "ui", snap: "e0-client", setup: [oneReport], dur: 8.2, cam: [{ t: 0, on: ".slice-bar", s: 1.6, dy: 150 }, { t: 2.6, on: ".slice-bar", s: 1.6, dy: 150 }, { t: 3.8, on: exact("32,550"), s: 2.4, dx: 160, dy: 20 }, { t: 5.6, on: exact("32,550"), s: 2.4, dx: 160, dy: 20 }, { t: 6.8, on: card("Total amount by client"), s: 1.7, dx: -40 }] },
    { kind: "card", dur: 4.2, lines: [{ text: "You see 112,050. They see 32,550.", at: 0.1 }, { text: "Nobody else's numbers leave the server.", at: 1.3, soft: true }] },
    { kind: "end", dur: 4.0 },
  ],
};

// --- Priya, data lead: an AI answer you can check --------------------------------------------------
FILMS.trust2 = {
  wide: true,
  what: "An AI answer you can check, and keep checking.",
  cta: "In review. Not yet released.",
  scenes: [
    { kind: "ui", snap: "e1-passed", stay: true, dur: 3.4, cam: [{ t: 0, on: byText(".def-chip", "Agent gets it right"), s: 2.6, dx: -160, dy: 20 }] },
    { kind: "card", dur: 3.4, lines: [{ text: "Every BI tool has an assistant now.", at: 0.1 }, { text: "Which of its answers were right last week?", at: 1.1, soft: true }] },
    { kind: "card", dur: 3.0, lines: [{ text: "A badge is not a test.", at: 0.1 }, { text: "So we made the answer one.", at: 0.9, soft: true }] },

    step(1, "Add your data", "an orders export, nothing set up"),
    { kind: "ui", snap: "a0-home", dur: 2.8, cam: [{ t: 0, on: byText(".home-tile", "Upload a file"), s: 1.9, dx: 180, dy: 40 }], cursor: press(byText(".home-tile", "Upload a file"), 1.9) },
    { kind: "ui", snap: "a1-table", dur: 2.6, cam: [{ t: 0, on: ".wb-toolbar", s: 1.5, dx: -200, dy: 260 }] },

    step(2, "Ask in plain words"),
    { kind: "ui", snap: "a1-table", dur: 3.4, live: [typeInto(askInput, "What was revenue?", 0.4, 14)], cam: [{ t: 0, on: askInput, s: 2.0, dy: 140 }], cursor: press(askGo, 2.6, "bottom", 50) },
    { kind: "ui", stay: true, snap: "b0-answer", setup: [panelEnd], dur: 6.6, cam: [{ t: 0, on: panelReply, s: 2.3 }, { t: 3.0, on: panelReply, s: 2.3 }, { t: 4.2, on: panelReply, s: 2.3, dy: 110 }] },

    step(3, "It models the data itself", "and asks the one thing it cannot know"),
    { kind: "ui", snap: "c0-needs", dur: 9.4, cam: [{ t: 0, on: ".need-settled", s: 2.5, dy: 60 }, { t: 2.8, on: ".need-settled", s: 2.5, dy: 60 }, { t: 4.0, on: firstQ, s: 1.7, dy: 20 }], cursor: press(inside(firstQ, ".need-option"), 7.6, "right", 70) },
    { kind: "ui", stay: true, snap: "c1-picked", dur: 2.8, cam: [{ t: 0, on: firstQ, s: 1.7, dy: 20 }], cursor: press(inside(firstQ, ".need-actions .primary-inline"), 1.8, "bottom", 50) },
    { kind: "ui", stay: true, snap: "c2-answered", dur: 3.4, cam: [{ t: 0, on: ".ok-note", s: 1.55, dy: 120 }] },

    step(4, "Ask again", "then say it is right"),
    { kind: "ui", snap: "d0-answer", setup: [panelEnd], dur: 5.6, cam: [{ t: 0, on: panelReply, s: 2.3 }], cursor: press(last(".gz-right .chat-verify button"), 4.6, "bottom", 50) },
    { kind: "ui", stay: true, snap: "d1-marked", setup: [panelEnd], dur: 2.6, cam: [{ t: 0, on: last(".gz-right .chat-verify"), s: 2.4, dy: -80 }] },

    step(5, "Now it is a test", "the agent is asked again and graded"),
    { kind: "ui", snap: "e0-checked", dur: 4.6, cam: [{ t: 0, on: byText("button", "Test the agent"), s: 1.9, dx: 260, dy: 40 }], cursor: press(byText("button", "Test the agent"), 3.6, "bottom", 50) },
    { kind: "ui", stay: true, snap: "e1-passed", dur: 4.0, cam: [{ t: 0, on: byText("button", "Test the agent"), s: 1.9, dx: 260, dy: 40 }, { t: 1.2, on: byText(".def-chip", "Agent gets it right"), s: 2.6, dx: -160, dy: 20 }] },
    { kind: "card", dur: 4.0, lines: [{ text: "Confirmed once.", at: 0.1 }, { text: "Checked every time the agent changes.", at: 1.0, soft: true }] },
    { kind: "end", dur: 4.0 },
  ],
};

// ---- Ana, data analyst: from an export to an answer with its whole trail. No agent, so nothing is staged.
const resultTable = ".sql-result-table";
const runSql = (el) => [...el.querySelectorAll(".primary-inline")].find((n) => n.textContent.trim() === "Run");
const lastCell = last("[data-testid=cell]");
const totalCard = closest(exact("Total amount"), ".widget-card");
const regionCard = card("Total amount by region");

FILMS.analyst = {
  wide: true,
  what: "The number, and everything behind it.",
  cta: "In review. Not yet released.",
  scenes: [
    { kind: "ui", snap: "f0-filtered", stay: true, dur: 3.4, cam: [{ t: 0, on: totalCard, s: 2.3, dx: -120, dy: 40 }] },
    { kind: "card", dur: 3.2, lines: [{ text: "An analyst hands over a number.", at: 0.1 }, { text: "The job is the trail behind it.", at: 1.0, soft: true }] },
    { kind: "card", dur: 3.4, lines: [{ text: "The query. The rows. The working.", at: 0.1 }, { text: "Often in four different tools.", at: 1.1, soft: true }] },
    { kind: "card", dur: 2.8, lines: [{ text: "Here it is in one.", at: 0.1 }, { text: "From an empty account.", at: 0.8, soft: true }] },

    step(1, "Add your data", "an orders export, nothing set up"),
    { kind: "ui", snap: "a0-home", dur: 2.8, cam: [{ t: 0, on: byText(".home-tile", "Upload a file"), s: 1.9, dx: 180, dy: 40 }], cursor: press(byText(".home-tile", "Upload a file"), 1.9) },
    { kind: "ui", snap: "a1-table", dur: 2.8, cam: [{ t: 0, on: ".wb-toolbar", s: 1.5, dx: -200, dy: 260 }] },

    step(2, "Ask it yourself", "your own SQL, over every row"),
    { kind: "ui", snap: "b0-sql", dur: 4.4, cam: [{ t: 0, on: ".code-editor", s: 1.8, dx: -40, dy: 40 }], cursor: press(runSql, 3.5, "bottom", 50) },
    { kind: "ui", stay: true, snap: "b1-result", dur: 3.8, cam: [{ t: 0, on: ".code-editor", s: 1.8, dx: -40, dy: 40 }, { t: 1.0, on: resultTable, s: 1.9, dy: -40 }] },

    step(3, "Build the card by hand", "no waiting on anyone"),
    { kind: "ui", snap: "c0-empty", dur: 2.8, cam: [{ t: 0, on: byText("button", "Add a card from a table"), s: 1.8, dx: 220, dy: 60 }], cursor: press(byText("button", "Add a card from a table"), 1.9, "bottom", 50) },
    { kind: "ui", snap: "c2-builder", dur: 6.4, cam: [{ t: 0, on: ".builder-form", s: 1.6, dx: 60 }, { t: 2.6, on: ".builder-form", s: 1.6, dx: 60 }, { t: 3.8, on: ".builder-preview", s: 1.6, dy: 40 }], cursor: press(byText(".builder-dialog button", "Add to report"), 5.6, "bottom", 50) },
    { kind: "ui", snap: "c3-report", dur: 3.4, cam: [{ t: 0, on: regionCard, s: 1.9, dx: 120, dy: 20 }] },

    step(4, "Show your work", "the rows behind the chart"),
    { kind: "ui", snap: "d0-menu", dur: 2.8, cam: [{ t: 0, on: byText(".widget-menu-item", "Open large"), s: 2.0, dx: 60, dy: 40 }], cursor: press(byText(".widget-menu-item", "Open large"), 1.9) },
    { kind: "ui", snap: "d1-large", dur: 2.6, cam: [{ t: 0, on: byText("button", "Rows behind it"), s: 1.7, dx: -260, dy: 200 }], cursor: press(byText("button", "Rows behind it"), 1.8, "bottom", 50) },
    { kind: "ui", stay: true, snap: "d2-rows", setup: [scrollTo(".focus-data")], dur: 4.6, cam: [{ t: 0, on: ".focus-data", s: 1.7, dy: -60 }] },

    step(5, "Keep the reasoning", "a notebook: notes, SQL and Python"),
    { kind: "ui", snap: "e0-notebook", dur: 5.0, cam: [{ t: 0, on: lastCell, s: 1.75, dy: -20 }], cursor: press(inside(lastCell, ".cell-bar .secondary"), 4.1, "bottom", 50) },
    { kind: "ui", stay: true, snap: "e1-ran", dur: 5.0, cam: [{ t: 0, on: lastCell, s: 1.75, dy: -20 }, { t: 1.0, on: ".cell-result", s: 1.9, dy: -10 }] },

    step(6, "Hand it over", "a link that opens with your filters"),
    { kind: "ui", snap: "f0-filtered", dur: 4.4, cam: [{ t: 0, on: ".filter-bar", s: 1.7, dy: 120 }], cursor: press(byText(".filter-bar button", "Copy link with filters"), 3.4, "bottom", 50) },
    { kind: "ui", stay: true, snap: "f0-filtered", dur: 3.6, cam: [{ t: 0, on: ".filter-bar", s: 1.7, dy: 120 }, { t: 1.0, on: totalCard, s: 2.3, dx: -120, dy: 40 }] },
    { kind: "card", dur: 4.0, lines: [{ text: "The number, and everything behind it.", at: 0.1 }, { text: "Query, rows, working, link. One place.", at: 1.1, soft: true }] },
    { kind: "end", dur: 4.0 },
  ],
};
