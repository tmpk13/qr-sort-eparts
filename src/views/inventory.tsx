// Inventory: scan bags into the current bag or batch, with auto capture, auto save and photos.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { batchTitle, display, itemName, itemTag, isUnidentified, parseQrPayload, placeOfBag, placeText, title,
    type Item, type LabelKind } from "../model.ts";
import { goTo } from "../nav.ts";
import { ledFlash, ledSteady } from "../led.ts";
import { readText, warmUp } from "../ocr.ts";
import { familyKey, guessType, identifiable, parseCode, parseLabelText, type Parsed, type TextRead } from "../parse.ts";
import { AutoCapture, FORMATS_PARTS, pickCode, type Camera, type Decoder, type Detection } from "../scanner.ts";
import { settings, useSettings, type Settings } from "../settings.ts";
import { blankItem, store, useData, type SaveResult } from "../store.ts";
import { BlobImage, CameraPanel, ItemForm, QtyBadge, Tag, Thumb, Toggle, toast, val, type Flash } from "../ui.tsx";

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
        // Nothing to file it under: it waits among the unidentified scans, out of the bag being filled.
        item.source = "unknown";
        item.bagId = null;
        item.batchId = null;
    }
    item.type = s.typeHints[familyKey(parsed.mpn)] ?? guessType(parsed.mpn);
    return item;
}

/** What the user is told after a save, and the matching camera sign and LED color. */
export function outcome(r: SaveResult, target: Target): Flash {
    const at = Date.now();
    const what = `${itemTag(r.item)} ${itemName(r.item)}`;
    const where = display(store.bag(r.item.bagId)) || (r.item.batchId ? title(r.item.batchId) : "no bag");
    if (isUnidentified(r.item)) {
        return { kind: "unknown", text: r.rescan ? "Unidentified, already listed" : "Unidentified: kept apart", at };
    }
    if (r.rescan) {
        return { kind: "elsewhere", text: `Already counted: ${what} in ${where}`, at };
    }
    if (r.into && r.item.bagId !== target.bagId) {
        return { kind: "elsewhere", text: `${what} is in ${where}: put it there (now x${r.item.count ?? "?"})`, at };
    }
    if (r.into) {
        return { kind: "ok", text: `Added to ${what}, now x${r.item.count ?? "?"}`, at };
    }
    return { kind: "ok", text: `Saved ${what}${r.item.qty != null ? ` x${r.item.qty}` : ""}`, at };
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
    const unknown = data.items.filter(isUnidentified).length;
    const place = placeOfBag(s.currentBagId, data);
    const recent = useMemo(() => [...data.items].sort((a, b) => b.updated - a.updated).slice(0, 8), [data.items]);

    useEffect(() => {
        if (cameraOn && s.textFallback) {
            warmUp();
        }
    }, [cameraOn, s.textFallback]);
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
        busy.current = true;
        try {
            const cur = settings.value;
            const t = await target();
            const item = itemFromParsed(parsed, t, cur);
            const shot = cur.savePhotos ? await shoot() : null;
            if (cur.autoSave) {
                const r = await store.saveItem(item, shot);
                show(outcome(r, t));
                toast(outcome(r, t).text, isUnidentified(r.item) ? "info" : "ok");
            } else {
                setDraft(item);
                setPhoto(shot);
                show({ kind: isUnidentified(item) ? "unknown" : "ok", text: "Check and save below", at: Date.now() });
            }
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
        if (!settings.value.textFallback) {
            toast("No code found in that photo", "err");
            return;
        }
        setTextStatus("No code; reading the text...");
        const read = parseLabelText(await readText(file));
        if (!read) {
            setTextStatus("");
            toast("No code and no part number in that photo", "err");
            return;
        }
        setTextStatus(`Text read at ${Math.round(read.confidence)}% confidence`);
        if (read.confidence >= settings.value.ocrConfidence) {
            await captureParsed(read, async () => file);
        } else {
            setDraft(itemFromParsed(read, await target(), settings.value));
            setPhoto(settings.value.savePhotos ? file : null);
        }
    }

    async function saveDraft(): Promise<void> {
        if (!draft) {
            return;
        }
        let item = draft;
        if (isUnidentified(item) && identifiable(item)) {
            // Filled in by hand: no longer unidentified, so it goes where scans go now.
            item = { ...item, source: "manual", ...(await target()) };
        }
        const key = familyKey(item.mpn);
        if (key && item.type) {
            setS({ typeHints: { ...s.typeHints, [key]: item.type } });
        }
        const r = await store.saveItem(item, photo);
        const o = outcome(r, item);
        show(o);
        toast(o.text, "ok");
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
        const merged = results.filter((r) => r.into).length;
        toast(`Put ${results.length} items into ${display(store.bag(bagId))}${merged ? `, ${merged} merged` : ""}`, "ok");
    }

    async function clearBatch(): Promise<void> {
        if (batch && confirm(`Clear ${batchTitle(batch)}? Its ${batchItems.length} items stay.`)) {
            await store.clearBatch(batch.id);
            setS({ currentBatchId: null });
        }
    }

    const status = draft ? "Paused until the item below is saved or discarded"
        : textStatus || (s.autoScan ? "Auto: show a bag, take it away, show the next one" : "Press Scan now");
    const draftUnknown = !!draft && isUnidentified(draft) && !identifiable(draft);

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
                    <button class="btn" disabled={!!draft} onClick={async () => {
                        const t = await target();
                        setDraft(blankItem(t.bagId, t.batchId));
                        setPhoto(null);
                    }}>
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
                <div class={`panel stack${draftUnknown ? " unknown" : ""}`}>
                    <h2 style="margin:0">
                        {draftUnknown ? "Unidentified scan" : draft.raw ? "Scanned item" : "New item"}
                    </h2>
                    {draftUnknown && (
                        <p class="hint">No part number in this code. Saved as it is, it goes to the unidentified
                            scans; fill in a part number to file it normally.</p>
                    )}
                    <ItemForm item={draft} onChange={setDraft} />
                    {photo && <BlobImage blob={photo} />}
                    <div class="row">
                        <button class="btn primary" onClick={saveDraft}>Save</button>
                        <button class="btn" onClick={() => { setDraft(null); setPhoto(null); }}>Discard</button>
                    </div>
                </div>
            )}

            {unknown > 0 && (
                <div class="panel row between unknown">
                    <span>{unknown} unidentified {unknown === 1 ? "scan waits" : "scans wait"} to be identified.</span>
                    <button class="btn small" onClick={() => goTo("browse")}>Show</button>
                </div>
            )}

            <div class="panel">
                <h2>Recent</h2>
                {recent.length ? (
                    <ul class="list">
                        {recent.map((item) => (
                            <li key={item.id} class={isUnidentified(item) ? "unknown" : ""}>
                                <Thumb item={item} />
                                <div class="grow">
                                    <div class="title"><Tag item={item} /> {itemName(item)}</div>
                                    <div class="small muted">
                                        {isUnidentified(item) ? "Unidentified"
                                            : [item.type, item.vendorPn, display(store.bag(item.bagId))
                                                || (item.batchId ? title(item.batchId) : "")].filter(Boolean).join(" / ")}
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
