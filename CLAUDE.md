# CLAUDE.md

Fork of upstream Git (`git/git`) that also hosts standalone apps, one per top-level directory:

- `musiksparring/`: AI creative coach for musicians (vanilla JS). See `musiksparring/CLAUDE.md`.

## Rules

- Work inside the app directory the task is about and run its commands from there.
- Everything else (C sources, `Documentation/`, `t/`, `po/`, `.github/`, `Makefile`, …) is upstream Git, merged in
  from upstream. Don't edit it for app work, and don't build Git or run `t/` for it.
- Prefix commit subjects with the app directory: `musiksparring: fix slash-chord parsing`.

## Cloud sessions

`.claude/hooks/session-start.sh` (SessionStart, cloud only) runs `npm install` in every top-level directory with a
`package-lock.json` and exports `PW_CHROMIUM=/opt/pw-browsers/chromium`: the pinned Playwright expects a newer
Chromium than the container ships. A new npm app needs no hook change.
