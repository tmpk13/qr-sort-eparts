# Completed

- Shelf > box > bag > item model with QR payloads for bag and box labels.
- DigiKey (old and new label), Mouser and LCSC code parsing; part type heuristic with learning.
- IndexedDB storage (idb) with photos, id counters, JSON backup and restore.
- Camera with zxing-wasm decoding in a worker; auto capture (settle, release); auto save toggle;
  photo saving; scan from a photo file; manual entry.
- Inventory view: current bag, bag and box label handling, recent items.
- Find view: search, shelf guidance (left, right, here, other shelf), contents of a scanned label.
- Browse view: tree editing, placement with renumbering, label dialog, item editing.
- Settings view: toggles, bridge test, label size, camera choice, backups, sample data.
- Label rendering at 8 dots per mm with crisp QR and thresholded text; print or download.
- Python bridge serving dist/ and printing through tprint over USB or Bluetooth; TLS option.
- Tests: bun unit tests, fake IndexedDB store tests, zxing round trips, pytest for the bridge,
  Playwright end-to-end with a fake camera.
- mise tasks, README with architecture diagram, NOTES.
