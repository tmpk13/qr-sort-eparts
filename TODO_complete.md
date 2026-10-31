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
- Unidentified scans kept apart in their own list, magenta sign and LED color.
- Big capture sign over the camera (green saved, orange elsewhere/already counted, magenta, red).
- 1D barcodes (Code 128/39/93) with data identifiers, joined per frame; PDF417 added.
- Read-text fallback (tesseract.js, offline) with a confidence threshold; manual and photo reads.
- Camera zoom (hardware or crop) with crop-matched photos; closer look at located-but-unread codes,
  full-resolution regions and stills.
- CSV export; bag quantity separate from current count.
- Batches: start/new, batch mode, put in bag, clear without losing items.
- Browse edit mode: click and shift-click selection, move items/bags/boxes.
- Find results open the item in Browse; short item ids (I-12) everywhere, searchable.
- One record per part number per box, with rescan detection and a merge for older data.
- RP2040 status LED firmware (GP2/3/4, USB CDC-ACM) and bridge /api/led, optional.
- Photos of bags with no code ("Photo, no code", or a chosen photo where nothing reads), in their own
  list with a violet sign and LED color; unidentified codes and photos stay unidentified when put in
  a bag or their bag in a box, until given a part number or a name.
