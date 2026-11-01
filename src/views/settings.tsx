// Settings: scanning defaults, the marker count, the print bridge, label size, camera choice and backups.
import { useState } from "preact/hooks";
import { bridgeUrl, downloadBlob, printerInfo, type PrinterInfo } from "../printer.ts";
import { DEFAULTS, useSettings } from "../settings.ts";
import type { Item } from "../model.ts";
import { blankItem, store, useData } from "../store.ts";
import { Field, Toggle, toast, val } from "../ui.tsx";
import { valueFromPartNumber } from "../value.ts";
import { exportCsv } from "./browse.tsx";
import { MarkerPanel } from "./marker.tsx";

export function SettingsView() {
    const [s, setS] = useSettings();
    const data = useData();
    const [info, setInfo] = useState<PrinterInfo | null>(null);
    const [testing, setTesting] = useState(false);
    const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
    const [led, setLed] = useState("");

    const testLed = async () => {
        try {
            const r = await fetch(bridgeUrl(s.bridgeUrl, "/api/led"), { signal: AbortSignal.timeout(4000) });
            const j = (r.headers.get("content-type") ?? "").includes("json") ? await r.json() : null;
            setLed(!j ? "no bridge at this server" : j.attached ? `attached at ${j.port}` : "not attached");
            if (j?.attached) {
                for (const color of ["#ff0000", "#00ff00", "#0000ff", "#000000"]) {
                    await fetch(bridgeUrl(s.bridgeUrl, "/api/led"), { method: "POST", body: JSON.stringify({ color }),
                        headers: { "Content-Type": "application/json" } });
                    await new Promise((res) => setTimeout(res, 400));
                }
            }
        } catch (err) {
            setLed(`no bridge: ${(err as Error).message}`);
        }
    };

    const test = async () => {
        setTesting(true);
        const i = await printerInfo(s.bridgeUrl);
        setInfo(i);
        setTesting(false);
        if (i.ok && i.labelMm && i.labelMm[0] && i.labelMm[1]) {
            setS({ labelW: i.labelMm[0], labelH: i.labelMm[1] });
        }
    };

    const listCameras = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true });
            stream.getTracks().forEach((t) => t.stop());
        } catch {
            // without permission the list has no names, which is still usable
        }
        setCameras((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput"));
    };

    const exportJson = async () => {
        const b = await store.exportBackup();
        const day = new Date().toISOString().slice(0, 10);
        downloadBlob(new Blob([JSON.stringify(b, null, 2)], { type: "application/json" }), `qr-sort-${day}.json`);
    };

    const importJson = async (file: File) => {
        if (!confirm("Replace everything in this browser with the backup? Photos are not in backups.")) {
            return;
        }
        try {
            await store.importBackup(JSON.parse(await file.text()));
            toast("Backup restored", "ok");
        } catch (err) {
            toast((err as Error).message, "err");
        }
    };

    const loadSample = async () => {
        const shelf = await store.createShelf("Left wall");
        const boxes = [];
        for (const name of ["Passives", "Semiconductors", "Connectors"]) {
            boxes.push(await store.createBox(name, shelf.id));
        }
        const bag = await store.createBag("0805 resistors", boxes[0].id);
        await store.createBag("Ceramic caps", boxes[0].id);
        const bag2 = await store.createBag("Logic", boxes[1].id);
        const now = Date.now();
        const item = (bagId: string, fields: Partial<Item>) => ({ ...blankItem(bagId), count: fields.qty ?? null,
            value: valueFromPartNumber(fields.mpn ?? ""), ...fields, created: now, updated: now });
        await store.saveItem(item(bag.id, { type: "resistor", mpn: "RC0805FR-0710KL", vendorPn: "311-10KARCT-ND", qty: 100,
            dateCode: "2310", source: "digikey" }));
        await store.saveItem(item(bag.id, { type: "resistor", mpn: "RC0805FR-071KL", vendorPn: "311-1.0KARCT-ND", qty: 100,
            source: "digikey" }));
        await store.saveItem(item(bag2.id, { type: "ic", name: "Single AND gate", mpn: "SN74LVC1G08DBVR",
            vendorPn: "296-8286-1-ND", qty: 10, source: "digikey" }));
        setS({ currentBagId: bag.id });
        toast("Sample data loaded", "ok");
    };

    const clearAll = async () => {
        if (confirm("Delete every shelf, box, bag, item and photo in this browser?")) {
            await store.clearAll();
            setS({ currentBagId: null });
            toast("Everything deleted");
        }
    };

    return (
        <div class="stack">
            <div class="panel stack">
                <h2 style="margin:0">Scanning</h2>
                <Toggle label="Auto scan: capture when a new bag comes into view" value={s.autoScan}
                    onChange={(v) => setS({ autoScan: v })} />
                <Toggle label="Auto save: store captures without asking" value={s.autoSave}
                    onChange={(v) => setS({ autoSave: v })} />
                <Toggle label="Save a photo of each bag" value={s.savePhotos} onChange={(v) => setS({ savePhotos: v })} />
                <Toggle label="Take a full-resolution still when a code is found but will not read" value={s.stills}
                    onChange={(v) => setS({ stills: v })} />
                <Toggle label="Read the label text when there is no code (slower; loads a text reader)"
                    value={s.textFallback} onChange={(v) => setS({ textFallback: v })} />
                {s.textFallback && (
                    <Field label={`Minimum text confidence: ${s.ocrConfidence}%`}>
                        <input type="range" min="0" max="100" step="5" value={s.ocrConfidence}
                            onInput={(e) => setS({ ocrConfidence: Number(val(e)) })} />
                    </Field>
                )}
                <p class="hint">
                    Codes in view count when they name a part: Data Matrix, QR and PDF417 codes, or rows of 1D
                    barcodes with data identifiers (1P, Q, ...). A code without a part number is saved where it
                    was scanned, flagged unidentified. Text reads below the minimum confidence are not used by
                    themselves.
                </p>
            </div>

            <MarkerPanel />

            <div class="panel stack">
                <h2 style="margin:0">Status LED</h2>
                <Toggle label="Show the scan status on an LED attached to the bridge" value={s.led}
                    onChange={(v) => setS({ led: v })} />
                <div class="row">
                    <button class="btn" onClick={testLed}>Test LED</button>
                    {led && <span class="badge">{led}</span>}
                </div>
                <p class="hint">
                    Green: saved. Magenta: saved unidentified, with a code. Violet: saved unidentified, with no
                    code. Orange: that label was counted already. Red: error. Nothing happens when no LED is attached.
                </p>
            </div>

            <div class="panel stack">
                <h2 style="margin:0">Printing</h2>
                <Field label="Print bridge URL (empty: the server this page came from)">
                    <input value={s.bridgeUrl} placeholder="http://localhost:8790" onInput={(e) => setS({ bridgeUrl: val(e) })} />
                </Field>
                <div class="row">
                    <button class="btn" onClick={test} disabled={testing}>{testing ? "Asking..." : "Test printer"}</button>
                    {info && (
                        <span class={`badge ${info.ok ? "ok" : "err"}`}>
                            {info.ok ? `Printer ready over ${info.transport}, label ${info.labelMm?.join("x")} mm` : info.error}
                        </span>
                    )}
                </div>
                <div class="grid">
                    <Field label="Label width (mm)">
                        <input type="number" min="10" max="48" value={s.labelW} onInput={(e) => setS({ labelW: Number(val(e)) || DEFAULTS.labelW })} />
                    </Field>
                    <Field label="Label height (mm)">
                        <input type="number" min="10" max="200" value={s.labelH} onInput={(e) => setS({ labelH: Number(val(e)) || DEFAULTS.labelH })} />
                    </Field>
                    <Field label="Burn density (0 to 15)">
                        <input type="number" min="0" max="15" value={s.density} onInput={(e) => setS({ density: Math.min(15, Math.max(0, Number(val(e)) || 0)) })} />
                    </Field>
                </div>
                <p class="hint">The size is read from the printer whenever the bridge can reach it; these values are the fallback.</p>
            </div>

            <div class="panel stack">
                <h2 style="margin:0">Camera</h2>
                <div class="row">
                    <select style="flex:1" value={s.cameraId} onChange={(e) => setS({ cameraId: val(e) })}>
                        <option value="">Default (rear camera when there is one)</option>
                        {cameras.map((c) => <option value={c.deviceId}>{c.label || c.deviceId.slice(0, 8)}</option>)}
                    </select>
                    <button class="btn" onClick={listCameras}>List cameras</button>
                </div>
            </div>

            <div class="panel stack">
                <h2 style="margin:0">Data</h2>
                <p class="small muted">
                    {data.shelves.length} shelves, {data.boxes.length} boxes, {data.bags.length} bags, {data.items.length} items,
                    stored in this browser only.
                </p>
                <div class="row">
                    <button class="btn" onClick={exportJson}>Export backup</button>
                    <button class="btn" onClick={() => exportCsv(data)}>Export CSV</button>
                    <label class="btn">
                        Restore backup
                        <input type="file" accept="application/json" hidden onChange={(e) => {
                            const input = e.currentTarget as HTMLInputElement;
                            const f = input.files?.[0];
                            input.value = "";
                            if (f) {
                                void importJson(f);
                            }
                        }} />
                    </label>
                    <button class="btn danger" onClick={clearAll}>Delete everything</button>
                    {!data.shelves.length && !data.items.length && (
                        <button class="btn" onClick={loadSample}>Load sample data</button>
                    )}
                    <button class="btn" onClick={() => setS({ typeHints: {} })}>Forget learned types ({Object.keys(s.typeHints).length})</button>
                </div>
                <p class="hint">
                    Each bag scanned is a record of its own, even for a part that is already in the box; the same
                    label scanned twice in a box counts once.
                </p>
            </div>
        </div>
    );
}
