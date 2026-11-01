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
- One record per part number per box, with rescan detection and a merge for older data (replaced:
  every bag is its own record, below).
- RP2040 status LED firmware (GP2/3/4, USB CDC-ACM) and bridge /api/led, optional.
- Photos of bags with no code, in their own list with a violet sign and LED color; unidentified codes
  and photos stay unidentified when moved, until given a part number or a name (the button became
  part of "Add by hand", below).
- Unidentified is a flag on items filed where they were scanned; it stays through moves until a part
  number or a name is given. Codes and photos listed apart as well.
- "Add by hand" takes a photo (camera or file); "Scan a photo" opens it when nothing reads.
- Every bag is its own record (no quantity summing); the same label in a box counts once.
- Component values read from common resistor/capacitor part numbers and label descriptions, shown in
  the lists and the CSV.
- Sorting by type then value in bags, a box's "All parts" list and edit mode.
- "Retake last" replaces the photo of the bag saved last.
- Marker count: pick the marker color in a picture, tune with a live isolated preview, read the
  written count on each saved bag (and from an item's photo in Browse).
- Import from Google Drive: an Apps Script web app (drive/) answers with every CSV file and Sheet in
  a folder; Settings > Import matches columns by heading, files rows by bag, box and shelf name or
  number, and skips rows imported before. Local CSV files import the same way.
