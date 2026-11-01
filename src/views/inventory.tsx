// Inventory: scan bags into the current bag or batch, with auto capture, auto save and photos.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { readMarkerCount } from "../marker.ts";
import { batchTitle, display, hasIdentity, itemName, itemTag, isUnidentified, parseQrPayload, placeOfBag, placeText,
    title, UNIDENTIFIED, unidentifiedKind, type Item, type LabelKind, type Unidentified } from "../model.ts";
import { goTo } from "../nav.ts";
import { ledFlash, ledSteady } from "../led.ts";
import { readText, warmUp } from "../ocr.ts";
import { familyKey, guessType, identifiable, parseCode, parseLabelText, type Parsed, type TextRead } from "../parse.ts";
import { AutoCapture, FORMATS_PARTS, pickCode, type Camera, type Decoder, type Detection } from "../scanner.ts";
import { settings, useSettings, type Settings } from "../settings.ts";
import { blankItem, store, useData, type SaveResult } from "../store.ts";
import { valueFromDescription, valueFromPartNumber } from "../value.ts";
import { BlobImage, CameraPanel, ItemForm, ItemTitle, QtyBadge, Thumb, Toggle, toast, val, waitingClass, type Flash }
    from "../ui.tsx";

export interface Target {
    bagId: string | null;
    batchId: string | null;
}

export function itemFromParsed(parsed: Parsed, target: Target, s: Settings): Item {
    const item = blankItem(target.bagId, target.batchId);
    item.source = parsed.source;
    item.raw = parsed.raw;
    item.mpn = parsed.mpn;
    item.vendorPn = parsed.vendorPn;
    item.qty = parsed.qty;
    item.count = parsed.qty;
    item.dateCode = parsed.dateCode;
    item.lot = parsed.lot;
    item.country = parsed.country;
    item.notes = [parsed.manufacturer && `Mfr ${parsed.manufacturer}`, parsed.notes].filter(Boolean).join("\n");
    if (parsed.source === "ocr") {
        const read = parsed as TextRead;
        item.name = parsed.fields.desc ?? "";
        const from = parsed.fields.vendor ? ` (${parsed.fields.vendor})` : "";
        item.notes = [item.notes, `Read from the label text${from}, ${Math.round(read.confidence)}% confidence`]
            .filter(Boolean).join("\n");
    }
    if (!identifiable(parsed)) {
        // Nothing to file it under: it goes where it was scanned, flagged until someone identifies it.
        item.source = "unknown";
        item.flags = [UNIDENTIFIED];
    }
    item.type = s.typeHints[familyKey(parsed.mpn)] ?? guessType(parsed.mpn);
    item.value = valueFromPartNumber(parsed.mpn) || valueFromDescription(parsed.fields.desc ?? "");
    return item;
}

/** What a record not saved yet would be flagged as: nothing says what it is, and it has a code or not. */
function draftKind(item: Item): Unidentified | null {
    return hasIdentity(item) ? null : item.raw ? "code" : "photo";
}

/** The camera sign for a kind of record: its own color while it is unidentified. */
function signKind(kind: Unidentified | null): Flash["kind"] {
    return kind === "photo" ? "nocode" : kind === "code" ? "unknown" : "ok";
}

/** "1 unidentified code waits", "2 unidentified codes and 1 photo with no code wait". */
function waitingText(codes: number, photos: number): string {
    const parts = [codes ? `${codes} unidentified ${codes === 1 ? "code" : "codes"}` : "",
        photos ? `${photos} ${photos === 1 ? "photo" : "photos"} with no code` : ""].filter(Boolean);
    return `${parts.join(" and ")} ${codes + photos === 1 ? "waits" : "wait"} to be identified.`;
}

/** Where a record is: its bag, else its batch. */
function whereText(item: Pick<Item, "bagId" | "batchId">): string {
    return display(store.bag(item.bagId)) || (item.batchId ? title(item.batchId) : "no bag");
}

/** What the user is told after a save, and the matching camera sign and LED color. */
export function outcome(r: SaveResult): Flash {
    const at = Date.now();
    const what = `${itemTag(r.item)} ${r.item.value ? `${r.item.value} ` : ""}${itemName(r.item)}`;
    const where = whereText(r.item);
    const kind = unidentifiedKind(r.item);
    if (r.rescan) {
        return kind === "code" ? { kind: "unknown", text: `Unidentified, already in ${where}`, at }
            : { kind: "elsewhere", text: `Already counted: ${what} in ${where}`, at };
    }
    if (kind === "photo") {
        return { kind: "nocode", text: `No code: ${itemTag(r.item)} in ${where}, unidentified`, at };
    }
    if (kind === "code") {
        return { kind: "unknown", text: `Unidentified: ${itemTag(r.item)} in ${where}`, at };
    }
    return { kind: "ok", text: `Saved ${what}${r.item.qty != null ? ` x${r.item.qty}` : ""}`, at };
}

/** A capture ready to save: the record, the camera's picture, and whether to keep that picture. */
interface Capture {
    item: Item;
    shot: Blob | null;
    keepShot: boolean;
}

export function InventoryView() {
    const data = useData();
    const [s, setS] = useSettings();
    const [cameraOn, setCameraOn] = useState(false);
    const [draft, setDraft] = useState<Item | null>(null);
    const [photo, setPhoto] = useState<Blob | null>(null);
    const [flash, setFlash] = useState<Flash | null>(null);
    const [textStatus, setTextStatus] = useState("");
    const [batchBag, setBatchBag] = useState("");
    const [lastId, setLastId] = useState<string | null>(null);
    const rig = useRef<{ camera: Camera; decoder: Decoder } | null>(null);
    const last = useRef<Detection[]>([]);
    const auto = useRef(new AutoCapture(2, 1500));
    const textAuto = useRef(new AutoCapture(1, 6000));
    const captured = useRef("");
    const busy = useRef(false);
    const reading = useRef(false);
    const lastCodeAt = useRef(0);
    const lastReadAt = useRef(0);
    const draftRef = useRef(draft);
    draftRef.current = draft;

    const bag = store.bag(s.currentBagId) ?? null;
    const batch = store.batch(s.currentBatchId) ?? null;
    const batchItems = batch ? data.items.filter((i) => i.batchId === batch.id) : [];
    const waiting = batchItems.filter((i) => !i.bagId).length;
    const codes = data.items.filter((i) => unidentifiedKind(i) === "code").length;
    const photos = data.items.filter((i) => unidentifiedKind(i) === "photo").length;
    const place = placeOfBag(s.currentBagId, data);
    const recent = useMemo(() => [...data.items].sort((a, b) => b.updated - a.updated).slice(0, 8), [data.items]);
    const lastItem = store.item(lastId);
    const markerOn = s.readMarker && !!s.marker;

    useEffect(() => {
        if (cameraOn && (s.textFallback || markerOn)) {
            warmUp();
        }
    }, [cameraOn, s.textFallback, markerOn]);
    useEffect(() => () => ledSteady("off"), []);
    // A new destination, so the bag in view may be meant for it: let it capture again.
    useEffect(() => auto.current.reset(), [s.currentBagId, s.batchMode, s.currentBatchId]);

    const show = (f: Flash) => {
        setFlash(f);
        ledFlash(f.kind === "ok" ? "ok" : f.kind);
    };

    /** Where a scan goes now: the current batch in batch mode (made on first use), else the current bag. */
    async function target(): Promise<Target> {
        const cur = settings.value;
        if (!cur.batchMode) {
            return { bagId: cur.currentBagId, batchId: null };
        }
        let id = store.batch(cur.currentBatchId)?.id ?? null;
        if (!id) {
            id = (await store.createBatch()).id;
            settings.set({ currentBatchId: id });
        }
        return { bagId: null, batchId: id };
    }

    const onFrame = (dets: Detection[], camera: Camera, misses: Detection[]) => {
        last.current = dets;
        const pick = pickCode(dets);
        const now = performance.now();
        if (pick || misses.length) {
            lastCodeAt.current = now;
        }
        ledSteady(pick || misses.length ? "seen" : "idle");
        const fire = auto.current.feed(pick?.key ?? null, now);
        const cur = settings.value;
        const free = cur.autoScan && !draftRef.current && !busy.current;
        if (fire && pick && free) {
            void capture(pick.text, () => camera.snapshot());
        } else if (free && cur.textFallback && !pick && !misses.length && !reading.current
            && now - lastCodeAt.current > 2000 && now - lastReadAt.current > 3000) {
            void readLabel(camera, true);
        }
    };

    async function capture(text: string, shoot: () => Promise<Blob | null>): Promise<void> {
        const label = parseQrPayload(text);
        if (label) {
            onLabel(label.kind, label.id);
            return;
        }
        captured.current = text;
        await captureParsed(parseCode(text), shoot);
    }

    async function captureParsed(parsed: Parsed, shoot: () => Promise<Blob | null>): Promise<void> {
        await keep(async () => {
            const cur = settings.value;
            const t = await target();
            // The picture is taken for the marker's count even when photos are not kept.
            const shot = cur.savePhotos || (cur.readMarker && cur.marker) ? await shoot() : null;
            return { item: itemFromParsed(parsed, t, cur), shot, keepShot: cur.savePhotos };
        });
    }

    /** Saves a capture, or holds it below for checking when auto save is off, and says what became of it. */
    async function keep(make: () => Promise<Capture>): Promise<void> {
        busy.current = true;
        try {
            const { item, shot, keepShot } = await make();
            if (settings.value.autoSave) {
                const r = await store.saveItem(item, keepShot ? shot : null);
                const o = outcome(r);
                show(o);
                toast(o.text, isUnidentified(r.item) ? "info" : "ok");
                setLastId(r.item.id);
                if (shot && !r.rescan) {
                    void readCount(r.item.id, true, shot);
                }
            } else {
                setDraft(item);
                setPhoto(keepShot ? shot : null);
                show({ kind: signKind(draftKind(item)), text: "Check and save below", at: Date.now() });
                if (shot) {
                    void readCount(item.id, false, shot);
                }
            }
        } catch (err) {
            show({ kind: "err", text: (err as Error).message, at: Date.now() });
            toast((err as Error).message, "err");
        } finally {
            busy.current = false;
        }
    }

    /**
     * Reads the count written on the bag in the marker's color, when that is switched on, into the
     * saved record or into the draft still open for it.
     */
    async function readCount(id: string, saved: boolean, shot: Blob): Promise<void> {
        const cur = settings.value;
        if (!cur.readMarker || !cur.marker) {
            return;
        }
        try {
            const read = await readMarkerCount(shot, cur.marker);
            if (!read) {
                return;
            }
            const conf = Math.round(read.confidence);
            if (conf < cur.markerConfidence) {
                toast(`Marker count ${read.count} read at ${conf}%, below ${cur.markerConfidence}%: not used`);
                return;
            }
            if (!saved) {
                setDraft((d) => (d && d.id === id ? { ...d, count: read.count } : d));
                return;
            }
            const item = store.item(id);
            if (item) {
                await store.saveItem({ ...item, count: read.count });
                toast(`Count ${read.count} read from the marker for ${itemTag(item)}`, "ok");
            }
        } catch (err) {
            toast(`Reading the marker failed: ${(err as Error).message}`, "err");
        }
    }

    /** A new photo for the record saved last, in case the first one missed or blurred. */
    async function retakeLast(): Promise<void> {
        const camera = rig.current?.camera;
        const item = store.item(lastId);
        if (!camera || !item || busy.current) {
            return;
        }
        busy.current = true;
        try {
            const shot = await camera.snapshot(0.92);
            if (!shot) {
                throw new Error("The camera has no picture yet");
            }
            await store.saveItem(item, shot);
            show({ kind: "ok", text: `New photo for ${itemTag(item)}`, at: Date.now() });
            toast(`New photo for ${itemTag(item)} ${itemName(item)}`, "ok");
            void readCount(item.id, true, shot);
        } catch (err) {
            show({ kind: "err", text: (err as Error).message, at: Date.now() });
            toast((err as Error).message, "err");
        } finally {
            busy.current = false;
        }
    }

    /** Reads the printed text of the label in view; automatic reads only use confident results. */
    async function readLabel(camera: Camera, automatic: boolean): Promise<void> {
        reading.current = true;
        const started = performance.now();
        lastReadAt.current = started;
        setTextStatus("Reading the label text...");
        try {
            const shot = await camera.snapshot(0.92);
            if (!shot) {
                return;
            }
            const read = parseLabelText(await readText(shot));
            if (automatic && lastCodeAt.current > started) {
                setTextStatus(""); // a code turned up meanwhile and has been handled
                return;
            }
            const min = settings.value.ocrConfidence;
            if (!read) {
                textAuto.current.feed(null, performance.now());
                setTextStatus(automatic ? "" : "No part number in the text");
                return;
            }
            const conf = Math.round(read.confidence);
            if (conf < min) {
                setTextStatus(`Text read at ${conf}% confidence, below ${min}%`);
                if (!automatic) {
                    setDraft(itemFromParsed(read, await target(), settings.value));
                    setPhoto(settings.value.savePhotos ? shot : null);
                }
                return;
            }
            if (automatic && !textAuto.current.feed(`text:${read.mpn || read.vendorPn}`, performance.now())) {
                setTextStatus("");
                return;
            }
            setTextStatus(`Text read at ${conf}% confidence`);
            await captureParsed(read, async () => shot);
        } catch (err) {
            setTextStatus(`Text reading failed: ${(err as Error).message}`);
        } finally {
            reading.current = false;
            lastReadAt.current = performance.now();
        }
    }

    function onLabel(kind: LabelKind, id: string): void {
        if (kind === "bag") {
            const b = store.bag(id);
            if (!b) {
                toast(`${title(id)} is not in the database`, "err");
                ledFlash("err");
            } else if (b.id !== settings.value.currentBagId) {
                setS({ currentBagId: b.id });
                setBatchBag(b.id);
                toast(`Now filling ${display(b)}`);
            }
            return;
        }
        const box = store.box(id);
        const cur = store.bag(settings.value.currentBagId);
        if (!box) {
            toast(`${title(id)} is not in the database`, "err");
            ledFlash("err");
        } else if (!cur) {
            toast("Pick a bag first, then scan the box label to put it there");
        } else if (cur.boxId !== box.id) {
            void store.saveBag({ ...cur, boxId: box.id });
            toast(`${display(cur)} is now in ${display(box)}`, "ok");
        }
    }

    async function scanNow(): Promise<void> {
        const pick = pickCode(last.current);
        const camera = rig.current?.camera;
        if (!pick || !camera) {
            toast("No code in view");
            return;
        }
        auto.current.reset();
        await capture(pick.text, () => camera.snapshot());
    }

    /** Opens the form for adding a bag by hand, with a photo when one is given. */
    async function addByHand(shot: Blob | null): Promise<void> {
        const t = await target();
        const item = blankItem(t.bagId, t.batchId);
        setDraft(item);
        setPhoto(shot);
        if (shot) {
            void readCount(item.id, false, shot);
        }
    }

    async function scanFile(file: File): Promise<void> {
        const decoder = rig.current?.decoder;
        if (!decoder) {
            return;
        }
        const pick = pickCode((await decoder.decode(file, FORMATS_PARTS)).results);
        if (pick) {
            await capture(pick.text, async () => file);
            return;
        }
        if (settings.value.textFallback) {
            setTextStatus("No code; reading the text...");
            const read = parseLabelText(await readText(file));
            if (read) {
                setTextStatus(`Text read at ${Math.round(read.confidence)}% confidence`);
                if (read.confidence >= settings.value.ocrConfidence) {
                    await captureParsed(read, async () => file);
                } else {
                    setDraft(itemFromParsed(read, await target(), settings.value));
                    setPhoto(settings.value.savePhotos ? file : null);
                }
                return;
            }
            setTextStatus("");
        }
        // Nothing in it reads, so it may be a bag with no code: offer it as one added by hand, with this photo.
        await addByHand(file);
        toast(settings.value.textFallback ? "No code and no part number in that photo" : "No code found in that photo");
    }

    /** A photo for the open draft, from the camera or from a file. */
    async function draftPhoto(shot: Blob | null): Promise<void> {
        if (!shot || !draft) {
            toast(shot ? "Nothing to add it to" : "The camera has no picture yet", "err");
            return;
        }
        setPhoto(shot);
        void readCount(draft.id, false, shot);
    }

    async function saveDraft(): Promise<void> {
        if (!draft) {
            return;
        }
        if (!draft.raw && !photo && !hasIdentity(draft)) {
            toast("Take a photo, or fill in a part number or a name", "err");
            return;
        }
        const key = familyKey(draft.mpn);
        if (key && draft.type) {
            setS({ typeHints: { ...s.typeHints, [key]: draft.type } });
        }
        const r = await store.saveItem(draft, photo);
        const o = outcome(r);
        show(o);
        toast(o.text, isUnidentified(r.item) ? "info" : "ok");
        setLastId(r.item.id);
        setDraft(null);
        setPhoto(null);
        auto.current.reset();
    }

    async function newBag(): Promise<void> {
        const b = await store.createBag("", bag?.boxId ?? null);
        setS({ currentBagId: b.id });
        toast(`Now filling ${display(b)}`);
    }

    async function newBatch(): Promise<void> {
        const b = await store.createBatch();
        setS({ batchMode: true, currentBatchId: b.id });
        toast(`Started ${batchTitle(b)}`);
    }

    async function putBatch(): Promise<void> {
        const bagId = batchBag || s.currentBagId;
        if (!batch || !bagId) {
            return;
        }
        const results = await store.putBatchInBag(batch.id, bagId);
        toast(`Put ${results.length} items into ${display(store.bag(bagId))}`, "ok");
    }

    async function clearBatch(): Promise<void> {
        if (batch && confirm(`Clear ${batchTitle(batch)}? Its ${batchItems.length} items stay.`)) {
            await store.clearBatch(batch.id);
            setS({ currentBatchId: null });
        }
    }

    const status = draft ? "Paused until the item below is saved or discarded"
        : textStatus || (s.autoScan ? "Auto: show a bag, take it away, show the next one" : "Press Scan now");
    // Saved as it is, the draft would be flagged as unidentified of this kind.
    const draftWaits = draft ? draftKind(draft) : null;

    return (
        <div class="stack">
            <div class="panel stack">
                <div class="row between">
                    <h2 style="margin:0">Scan</h2>
                    <div class="row">
                        <Toggle label="Auto scan" value={s.autoScan} onChange={(v) => setS({ autoScan: v })} />
                        <Toggle label="Auto save" value={s.autoSave} onChange={(v) => setS({ autoSave: v })} />
                        <Toggle label="Save photo" value={s.savePhotos} onChange={(v) => setS({ savePhotos: v })} />
                        <Toggle label="Read text" value={s.textFallback} onChange={(v) => setS({ textFallback: v })} />
                        {s.marker && (
                            <Toggle label="Read marker count" value={s.readMarker} onChange={(v) => setS({ readMarker: v })} />
                        )}
                    </div>
                </div>
                <CameraPanel active={cameraOn} onToggle={() => setCameraOn((on) => !on)} formats={FORMATS_PARTS}
                    onFrame={onFrame} onReady={(camera, decoder) => { rig.current = { camera, decoder }; }}
                    onRunning={(on) => {
                        ledSteady(on ? "idle" : "off");
                        auto.current.reset();
                    }}
                    highlight={(d) => (d.text === captured.current ? "#859900" : "#268bd2")} status={status}
                    flash={flash} />
                <div class="row">
                    <button class="btn primary" onClick={() => setCameraOn((on) => !on)}>
                        {cameraOn ? "Stop camera" : "Start camera"}
                    </button>
                    <button class="btn" disabled={!cameraOn || !!draft} onClick={scanNow}>Scan now</button>
                    <button class="btn" disabled={!cameraOn || !!draft || !lastItem} onClick={retakeLast}
                        title="Take the photo of the bag saved last again">
                        Retake last{lastItem ? ` (${itemTag(lastItem)})` : ""}
                    </button>
                    {s.textFallback && (
                        <button class="btn" disabled={!cameraOn || !!draft}
                            onClick={() => rig.current && !reading.current && void readLabel(rig.current.camera, false)}>
                            Read label text
                        </button>
                    )}
                    <label class="btn">
                        Scan a photo
                        <input type="file" accept="image/*" hidden onChange={(e) => {
                            const input = e.currentTarget as HTMLInputElement;
                            const f = input.files?.[0];
                            input.value = "";
                            if (f) {
                                void scanFile(f);
                            }
                        }} />
                    </label>
                    <button class="btn" disabled={!!draft} onClick={() => void addByHand(null)}
                        title="For a bag with no code that reads: take its photo, fill in what is known">
                        Add by hand
                    </button>
                </div>
            </div>

            <div class="panel stack">
                <div class="row between">
                    <h2 style="margin:0">Filling</h2>
                    <Toggle label="Batch mode" value={s.batchMode} onChange={(v) => setS({ batchMode: v })} />
                </div>
                {s.batchMode && (batch ? (
                    <div class="stack batch-box">
                        <div class="row between">
                            <span class="title">{batchTitle(batch)}</span>
                            <span class="badge">{batchItems.length} items, {waiting} not in a bag</span>
                        </div>
                        <div class="row">
                            <button class="btn" onClick={newBatch}>New batch</button>
                            <button class="btn danger" onClick={clearBatch}>Clear batch</button>
                        </div>
                        <div class="row">
                            <select style="flex:1" value={batchBag || s.currentBagId || ""} onChange={(e) => setBatchBag(val(e))}>
                                <option value="">(pick a bag)</option>
                                {data.bags.map((b) => <option value={b.id}>{display(b)}</option>)}
                            </select>
                            <button class="btn primary" disabled={!waiting || !(batchBag || s.currentBagId)} onClick={putBatch}>
                                Put batch in bag
                            </button>
                        </div>
                        <p class="hint">
                            Scans collect in the batch until it goes into a bag. Clearing the batch keeps its items.
                        </p>
                    </div>
                ) : (
                    <div class="row">
                        <button class="btn primary" onClick={newBatch}>Start batch</button>
                        <span class="hint">or just scan: the first scan starts one.</span>
                    </div>
                ))}
                <div class="row">
                    <select style="flex:1" value={s.currentBagId ?? ""} aria-label="Current bag"
                        onChange={(e) => setS({ currentBagId: val(e) || null })}>
                        <option value="">(no bag)</option>
                        {data.bags.map((b) => <option value={b.id}>{display(b)}</option>)}
                    </select>
                    <button class="btn" onClick={newBag}>New bag</button>
                </div>
                <p class="hint">
                    {s.batchMode ? "The bag above is where label scans point; items go into the batch. "
                        : bag ? `${placeText(place)}. ` : "Items saved without a bag can be moved later under Browse. "}
                    Scanning a bag label switches to that bag; scanning a box label puts the current bag in it.
                </p>
            </div>

            {draft && (
                <div class={`panel stack draft ${draftWaits === "code" ? "unknown" : draftWaits === "photo" ? "nocode" : ""}`}>
                    <h2 style="margin:0">
                        {!draft.raw ? "Add by hand" : draftWaits ? "Unidentified code" : "Scanned item"}
                    </h2>
                    {draftWaits === "code" && (
                        <p class="hint">No part number in this code. Saved as it is, it goes into {whereText(draft)}
                            flagged unidentified; a part number or a name identifies it.</p>
                    )}
                    {draftWaits === "photo" && (
                        <p class="hint">Without a part number or a name it goes into {whereText(draft)} flagged
                            unidentified, with its photo to tell what it is later.</p>
                    )}
                    <ItemForm item={draft} onChange={setDraft} />
                    {photo && <BlobImage blob={photo} />}
                    <div class="row">
                        <button class="btn" disabled={!cameraOn}
                            onClick={async () => void draftPhoto(await rig.current?.camera.snapshot(0.92) ?? null)}>
                            {photo ? "Retake photo" : "Take photo"}
                        </button>
                        <label class="btn">
                            Choose photo
                            <input type="file" accept="image/*" hidden onChange={(e) => {
                                const input = e.currentTarget as HTMLInputElement;
                                const f = input.files?.[0];
                                input.value = "";
                                if (f) {
                                    void draftPhoto(f);
                                }
                            }} />
                        </label>
                        {photo && <button class="btn" onClick={() => setPhoto(null)}>Remove photo</button>}
                    </div>
                    <div class="row">
                        <button class="btn primary" onClick={saveDraft}>Save</button>
                        <button class="btn" onClick={() => { setDraft(null); setPhoto(null); }}>Discard</button>
                    </div>
                </div>
            )}

            {codes + photos > 0 && (
                <div class={`panel row between ${codes ? "unknown" : "nocode"}`}>
                    <span>{waitingText(codes, photos)}</span>
                    <button class="btn small" onClick={() => goTo("browse")}>Show</button>
                </div>
            )}

            <div class="panel">
                <h2>Recent</h2>
                {recent.length ? (
                    <ul class="list">
                        {recent.map((item) => (
                            <li key={item.id} class={waitingClass(item)}>
                                <Thumb item={item} />
                                <div class="grow">
                                    <ItemTitle item={item} />
                                    <div class="small muted">
                                        {[item.type, item.vendorPn, whereText(item)].filter(Boolean).join(" / ")}
                                    </div>
                                </div>
                                <QtyBadge item={item} />
                                <button class="btn small" onClick={() => goTo("browse", { itemId: item.id })}>Open</button>
                                <button class="btn small danger" onClick={() => confirm(`Delete ${itemName(item)}?`)
                                    && store.deleteItem(item.id)}>Delete</button>
                            </li>
                        ))}
                    </ul>
                ) : <p class="muted">Nothing saved yet.</p>}
            </div>
        </div>
    );
}

export function describe(item: Item): string {
    return itemName(item) + (item.qty != null ? ` x${item.qty}` : "");
}
