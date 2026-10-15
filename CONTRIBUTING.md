# Contributing to Kestrel

Thanks for helping. Bug reports, FCS files that read incorrectly, and pull requests are all welcome.

## Set up

```sh
npm install
npx playwright install chromium
npm run dev        # rebuilds dist/kestrel.html on every change; open it in a browser
```

## Before opening a pull request

```sh
npm run lint && npm test && npm run build && npm run e2e
```

Commit the rebuilt `dist/kestrel.html` with your change; CI checks that it matches the source.

## Guidelines

- `src/core/` must stay dependency-free and runnable in Node and browsers. Add a unit test in `test/` for anything that computes numbers.
- Heavy work belongs in the engine (`src/engine/`), which runs in Web Workers; the UI only asks for results.
- Anything that changes saved workspaces or templates needs a migration in `src/ui/state/loader.js` (`migrateDoc`, `migrateTemplate`).
- If a file from your instrument reads incorrectly, please attach it (or a small anonymised one) to the issue.
