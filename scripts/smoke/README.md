# Staging smoke tests

Each script signs up a throwaway `@example.test` account on the target environment, exercises one milestone's features over the real API and socket, deletes its workbook, and prints `PASS` or `FAIL`.

```bash
node scripts/smoke/m3.mjs https://<control-domain> tests/e2e
node scripts/smoke/m3-gaps.mjs https://<control-domain> tests/e2e
```

The second argument is a folder whose `node_modules` contains `msgpackr` (`tests/e2e` does, after `npm ci` there).

Run them one at a time with a short pause between: staging rate-limits sign-ups and back-to-back runs can get a 429.
