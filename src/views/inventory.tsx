// Inventory: scan bags into the current bag, with auto capture, auto save and photos.
import { useMemo, useRef, useState } from "preact/hooks";
import { display, itemName, parseQrPayload, placeOfBag, placeText, title, type Item, type LabelKind } from "../model.ts";
import { familyKey, guessType, parseCode, type Parsed } from "../parse.ts";
import { AutoCapture, FORMATS_PARTS, pickCode, type Camera, type Decoder, type Detection } from "../scanner.ts";
import { settings, useSettings, type Settings } from "../settings.ts";
import { blankItem, store, useData } from "../store.ts";
import { BlobImage, CameraPanel, ItemForm, Thumb, Toggle, toast, val } from "../ui.tsx";

export function itemFromParsed(parsed: Parsed, bagId: string | null, s: Settings): Item {
    const item = blankItem(bagId);
    item.source = parsed.source;
    item.raw = parsed.raw;
    item.mpn = parsed.mpn;
    item.vendorPn = parsed.vendorPn;
    item.qty = parsed.qty;
    item.dateCode = parsed.dateCode;
    item.lot = parsed.lot;
    item.country = parsed.country;
    item.notes = [parsed.manufacturer && `Mfr ${parsed.manufacturer}`, parsed.notes].filter(Boolean).join("\n");
    if (parsed.source === "text") {
        item.name = parsed.raw;
    }
    item.type = s.typeHints[familyKey(parsed.mpn)] ?? guessType(parsed.mpn);
    return item;
}

export function InventoryView() {
    const data = useData();
    const [s, setS] = useSettings();
    const [cameraOn, setCameraOn] = useState(false);
    const [draft, setDraft] = useState<Item | null>(null);
    const [photo, setPhoto] = useState<Blob | null>(null);
    const [flash, setFlash] = useState("");
    const rig = useRef<{ camera: Camera; decoder: Decoder } | null>(null);
    const last = useRef<Detection[]>([]);
    const auto = useRef(new AutoCapture(2, 1500));
    const busy = useRef(false);
    const draftRef = useRef(draft);
    draftRef.current = draft;

    const bag = store.bag(s.currentBagId) ?? null;
    const place = placeOfBag(s.currentBagId, data);
    const recent = useMemo(() => [...data.items].sort((a, b) => b.created - a.created).slice(0, 8), [data.items]);

    const onFrame = (dets: Detection[], camera: Camera) => {
        last.current = dets;
        const pick = pickCode(dets);
        const fire = auto.current.feed(pick?.text ?? null, performance.now());
        if (fire && settings.value.autoScan && !draftRef.current && !busy.current) {
            void capture(fire, () => camera.snapshot());
        }
    };

    async function capture(text: string, shoot: () => Promise<Blob | null>): Promise<void> {
        busy.current = true;
        try {
            const cur = settings.value;
            const label = parseQrPayload(text);
            if (label) {
                onLabel(label.kind, label.id);
                return;
            }
            const item = itemFromParsed(parseCode(text), cur.currentBagId, cur);
            const shot = cur.savePhotos ? await shoot() : null;
            setFlash(text);
            if (cur.autoSave) {
                await store.saveItem(item, shot);
                toast(`Saved ${describe(item)} into ${display(store.bag(cur.currentBagId)) || "no bag"}`, "ok");
            } else {
                setDraft(item);
                setPhoto(shot);
            }
        } catch (err) {
            toast((err as Error).message, "err");
        } finally {
            busy.current = false;
        }
    }

    function onLabel(kind: LabelKind, id: string): void {
        if (kind === "bag") {
            const b = store.bag(id);
            if (!b) {
                toast(`${title(id)} is not in the database`, "err");
            } else if (b.id !== settings.value.currentBagId) {
                setS({ currentBagId: b.id });
                toast(`Now filling ${display(b)}`);
            }
            return;
        }
        const box = store.box(id);
        const cur = store.bag(settings.value.currentBagId);
        if (!box) {
            toast(`${title(id)} is not in the database`, "err");
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
        const dets = await decoder.decode(file, FORMATS_PARTS);
        const pick = pickCode(dets);
        if (!pick) {
            toast("No code found in that photo", "err");
            return;
        }
        await capture(pick.text, async () => file);
    }

    async function saveDraft(): Promise<void> {
        if (!draft) {
            return;
        }
        const key = familyKey(draft.mpn);
        if (key && draft.type) {
            setS({ typeHints: { ...s.typeHints, [key]: draft.type } });
        }
        await store.saveItem(draft, photo);
        toast(`Saved ${describe(draft)} into ${display(store.bag(draft.bagId)) || "no bag"}`, "ok");
        setDraft(null);
        setPhoto(null);
    }

    async function newBag(): Promise<void> {
        const b = await store.createBag("", bag?.boxId ?? null);
        setS({ currentBagId: b.id });
        toast(`Now filling ${display(b)}`);
    }

    const status = draft ? "Paused until the item below is saved or discarded"
        : s.autoScan ? "Auto: show a bag, take it away, show the next one" : "Press Scan now";

    return (
        <div class="stack">
            <div class="panel stack">
                <div class="row between">
                    <h2 style="margin:0">Scan</h2>
                    <div class="row">
                        <Toggle label="Auto scan" value={s.autoScan} onChange={(v) => setS({ autoScan: v })} />
                        <Toggle label="Auto save" value={s.autoSave} onChange={(v) => setS({ autoSave: v })} />
                        <Toggle label="Save photo" value={s.savePhotos} onChange={(v) => setS({ savePhotos: v })} />
                    </div>
                </div>
                <CameraPanel active={cameraOn} onToggle={() => setCameraOn((on) => !on)} formats={FORMATS_PARTS}
                    onFrame={onFrame} onReady={(camera, decoder) => { rig.current = { camera, decoder }; }}
                    highlight={(d) => (d.text === flash ? "#859900" : "#268bd2")} status={status} />
                <div class="row">
                    <button class="btn primary" onClick={() => setCameraOn((on) => !on)}>
                        {cameraOn ? "Stop camera" : "Start camera"}
                    </button>
                    <button class="btn" disabled={!cameraOn || !!draft} onClick={scanNow}>Scan now</button>
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
                    <button class="btn" disabled={!!draft}
                        onClick={() => { setDraft(blankItem(s.currentBagId)); setPhoto(null); }}>
                        Add by hand
                    </button>
                </div>
            </div>

            <div class="panel">
                <h2>Filling</h2>
                <div class="row">
                    <select style="flex:1" value={s.currentBagId ?? ""}
                        onChange={(e) => setS({ currentBagId: val(e) || null })}>
                        <option value="">(no bag)</option>
                        {data.bags.map((b) => <option value={b.id}>{display(b)}</option>)}
                    </select>
                    <button class="btn" onClick={newBag}>New bag</button>
                </div>
                <p class="hint">
                    {bag ? `${placeText(place)}.` : "Items saved without a bag can be moved later under Browse."}
                    {" "}Scanning a bag label switches to that bag; scanning a box label puts the current bag in it.
                </p>
            </div>

            {draft && (
                <div class="panel stack">
                    <h2 style="margin:0">{draft.raw ? "Scanned item" : "New item"}</h2>
                    <ItemForm item={draft} onChange={setDraft} />
                    {photo && <BlobImage blob={photo} />}
                    <div class="row">
                        <button class="btn primary" onClick={saveDraft}>Save</button>
                        <button class="btn" onClick={() => { setDraft(null); setPhoto(null); }}>Discard</button>
                    </div>
                </div>
            )}

            <div class="panel">
                <h2>Recent</h2>
                {recent.length ? (
                    <ul class="list">
                        {recent.map((item) => (
                            <li key={item.id}>
                                <Thumb item={item} />
                                <div class="grow">
                                    <div class="title">{describe(item)}</div>
                                    <div class="small muted">
                                        {[item.type, item.vendorPn, display(store.bag(item.bagId))].filter(Boolean).join(" / ")}
                                    </div>
                                </div>
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
