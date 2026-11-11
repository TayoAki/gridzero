# Concept films

Two silent product films made from the planned screens (`/preview`): `agency` (client reports on autopilot) and
`warehouse` (one number everyone trusts). Every screen in them is planned and holds sample data, so each film is tagged
"Concept preview" throughout and closes on "In development. Not yet available." They are not launch videos.

- `SCRIPTS.md`: the candidate scripts for each track, how they were scored, and the truth notes.
- `film.html`: both timelines (scenes, camera, cursor, timed edits). Every frame is a pure function of its number.
- `capture-dom.mjs`: runs the app locally and saves the rendered screens to `snap/snaps.json`. Run it again after a
  planned screen changes.
- `render.mjs`: `node render.mjs agency` or `node render.mjs warehouse` writes a 1920×1080, 30 fps master to `out/`
  (not committed). `node render.mjs agency stills 0 5.5 11` writes styleframes at those seconds.

Needs Playwright (from `tests/e2e`) and ffmpeg.

## Tutorial films

Two more films, each one person going from nothing to a result on real screens: `dana` (an orders export to a
confirmed number on a report) and `priya` (a Postgres database, scanned and confirmed). `TUTORIAL-SCRIPTS.md` has the
study of other tools, the scripts and the truth notes.

- `tut/capture1.mjs` and `tut/capture2.mjs` drive the real app locally and save each state to `tut/v1.json` and
  `tut/v2.json` (not committed; they hold pictures of the grid). Run them from `tests/e2e` with `DATABASE_URL` set.
- `tut-films.js` holds both timelines; `make_tut.py` builds `tut.html` from `film.html`.
- `node render.mjs dana` or `node render.mjs priya` writes the master.
