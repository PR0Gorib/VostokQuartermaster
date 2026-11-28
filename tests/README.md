# Quartermaster tests

Run from the repository root (needs `jsdom`: `npm i -D jsdom`):

    node tests/run-all.js            # all test files
    node tests/edits.test.js         # one file

The tests load the real `src/app.js`, `tres.js` and `pck.js` in jsdom with an in-memory file system, so no game, save or Tauri is needed.
If `app.js` is not in `./src`, set `VQ_SRC` to the folder that holds it. Add `"test": "node tests/run-all.js"` to package.json to use `npm test`.

| File | Covers |
| --- | --- |
| tres.test.js | parser/serializer round trips, validation, set/insert, ids, removing slots (including shared loose-item slot blocks), removing a mod's items |
| edits.test.js | condition, quantity, remove, move, add, shared loose items, moves between files, weapon attachments, random batches |
| traders.test.js | task states (not started / in progress / completed), no-op edits, escaping, broken files |
| character.test.js | character and world field values (meters, switches, day, time of day) |
| repair.test.js | finding mod items, cleaned copies, broken-item check and repair |
| rescue-box.test.js | saving items from removed mod furniture, dropping them back, 150-batch fuzz |
| snapshots.test.js | names, snapshots, auto-backup limit, restore, read-only protection |
| compare.test.js | the snapshot comparison |

Not covered (needs a real browser and layout): mouse dragging on grids and the tray.
