// Shared components: toasts, form bits, the camera panel with its overlay, the label dialog and
// the item form.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { canvasPng, renderLabel } from "./label.ts";
import { display, qrPayload, title, type Bag, type Item } from "./model.ts";
import { TYPES } from "./parse.ts";
import { downloadBlob, printPng, printerInfo, type PrinterInfo } from "./printer.ts";
import { Camera, Decoder, Scanner, type Detection, type FrameInfo } from "./scanner.ts";
import { settings, useSettings } from "./settings.ts";
import { store } from "./store.ts";

// ---- toasts ----
type ToastKind = "info" | "ok" | "err";
interface ToastMsg {
    id: number;
    text: string;
    kind: ToastKind;
}
const toastListeners = new Set<(t: ToastMsg[]) => void>();
let toasts: ToastMsg[] = [];
let toastSeq = 0;

export function toast(text: string, kind: ToastKind = "info"): void {
    const t = { id: ++toastSeq, text, kind };
    toasts = [...toasts.slice(-3), t];
    toastListeners.forEach((l) => l(toasts));
    setTimeout(() => {
        toasts = toasts.filter((x) => x !== t);
        toastListeners.forEach((l) => l(toasts));
    }, kind === "err" ? 6000 : 3000);
}

export function Toasts() {
    const [list, setList] = useState(toasts);
    useEffect(() => {
        toastListeners.add(setList);
        return () => {
            toastListeners.delete(setList);
        };
    }, []);
    return <div class="toasts">{list.map((t) => <div key={t.id} class={`toast ${t.kind}`}>{t.text}</div>)}</div>;
}

// ---- form bits ----
export function val(e: Event): string {
    return (e.currentTarget as HTMLInputElement).value;
}

export function Toggle(p: { label: string; value: boolean; onChange: (v: boolean) => void }) {
    return (
        <label class="toggle">
            <input type="checkbox" checked={p.value}
                onChange={(e) => p.onChange((e.currentTarget as HTMLInputElement).checked)} />
            {p.label}
        </label>
    );
}

export function Field(p: { label: string; wide?: boolean; children: ComponentChildren }) {
    return (
        <label class={p.wide ? "field wide" : "field"}>
            <span>{p.label}</span>
            {p.children}
        </label>
    );
}

export function Modal(p: { title: string; onClose: () => void; children: ComponentChildren }) {
    return (
        <div class="modal-back" onClick={(e) => e.target === e.currentTarget && p.onClose()}>
            <div class="modal stack">
                <div class="row between">
                    <h2 style="margin:0">{p.title}</h2>
                    <button class="btn small" onClick={p.onClose}>Close</button>
                </div>
                {p.children}
            </div>
        </div>
    );
}

// ---- camera ----
export interface CameraPanelProps {
    active: boolean;
    onToggle: () => void;
    formats: string[];
    onFrame: (dets: Detection[], camera: Camera) => void;
    onReady?: (camera: Camera, decoder: Decoder) => void;
    highlight?: (d: Detection) => string; // outline color per code
    status?: string;
    children?: ComponentChildren;
}

function cameraError(err: unknown): string {
    const e = err as { name?: string; message?: string };
    switch (e.name) {
        case "NotAllowedError":
            return "Camera permission was denied";
        case "NotFoundError":
        case "OverconstrainedError":
            return "No camera found";
        case "NotReadableError":
            return "The camera is in use by another app";
        default:
            return e.message ?? String(err);
    }
}

function drawOverlay(canvas: HTMLCanvasElement, dets: Detection[], frame: FrameInfo,
    highlight?: (d: Detection) => string): void {
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = Math.max(2, frame.width / 250);
    ctx.lineJoin = "round";
    for (const d of dets) {
        ctx.strokeStyle = highlight?.(d) ?? "#268bd2";
        ctx.beginPath();
        d.corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
        ctx.closePath();
        ctx.stroke();
    }
}

export function CameraPanel(p: CameraPanelProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const props = useRef(p);
    props.current = p;
    const rig = useRef<{ camera: Camera; decoder: Decoder; scanner: Scanner } | null>(null);
    const [error, setError] = useState("");
    const [running, setRunning] = useState(false);

    useEffect(() => {
        const camera = new Camera(videoRef.current!);
        const decoder = new Decoder();
        const scanner = new Scanner(camera, decoder, props.current.formats, (dets, frame) => {
            drawOverlay(canvasRef.current!, dets, frame, props.current.highlight);
            props.current.onFrame(dets, camera);
        });
        rig.current = { camera, decoder, scanner };
        props.current.onReady?.(camera, decoder);
        return () => {
            scanner.stop();
            camera.stop();
            decoder.close();
        };
    }, []);

    useEffect(() => {
        rig.current?.scanner.setFormats(p.formats);
    }, [p.formats.join(",")]);

    useEffect(() => {
        const r = rig.current!;
        if (!p.active) {
            r.scanner.stop();
            r.camera.stop();
            setRunning(false);
            const c = canvasRef.current;
            c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
            return;
        }
        let cancelled = false;
        setError("");
        (async () => {
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error("The camera needs HTTPS or localhost");
            }
            try {
                await r.camera.start(settings.value.cameraId);
            } catch (err) {
                if (!settings.value.cameraId) {
                    throw err;
                }
                settings.set({ cameraId: "" }); // the remembered camera is gone
                await r.camera.start("");
            }
        })().then(() => {
            if (cancelled) {
                r.camera.stop();
                return;
            }
            r.scanner.start();
            setRunning(true);
        }, (err) => {
            setError(cameraError(err));
            setRunning(false);
            if (!cancelled) {
                props.current.onToggle();
            }
        });
        return () => {
            cancelled = true;
        };
    }, [p.active]);

    return (
        <div class="camera">
            <video ref={videoRef} muted playsInline autoPlay />
            <canvas ref={canvasRef} />
            {!running && (
                <div class="center">
                    {error ? <span>{error}</span> : p.active
                        ? <span>Starting the camera...</span>
                        : <button class="btn primary" onClick={p.onToggle}>Start camera</button>}
                </div>
            )}
            {running && p.children}
            {running && p.status && <div class="status">{p.status}</div>}
        </div>
    );
}

// ---- labels ----
export function LabelDialog(p: { id: string; name: string; onClose: () => void }) {
    const [s] = useSettings();
    const [info, setInfo] = useState<PrinterInfo | null>(null);
    const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const host = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let live = true;
        printerInfo(s.bridgeUrl).then((i) => live && setInfo(i));
        return () => {
            live = false;
        };
    }, [s.bridgeUrl]);

    const fromPrinter = !!(info?.ok && info.labelMm && info.labelMm[0] && info.labelMm[1]);
    const [w, h] = fromPrinter ? info!.labelMm! : [s.labelW, s.labelH];

    useEffect(() => {
        try {
            const c = renderLabel({ payload: qrPayload(p.id), title: title(p.id).toUpperCase(), subtitle: p.name,
                wMm: w, hMm: h });
            c.className = "label-preview";
            setCanvas(c);
            setError("");
        } catch (err) {
            setCanvas(null);
            setError((err as Error).message);
        }
    }, [p.id, p.name, w, h]);

    useEffect(() => {
        host.current?.replaceChildren(...(canvas ? [canvas] : []));
    }, [canvas]);

    const print = async () => {
        if (!canvas) {
            return;
        }
        setBusy(true);
        try {
            await printPng(s.bridgeUrl, await canvasPng(canvas), s.density);
            toast(`Printed the label for ${title(p.id)}`, "ok");
        } catch (err) {
            toast((err as Error).message, "err");
        } finally {
            setBusy(false);
        }
    };
    const download = async () => canvas && downloadBlob(await canvasPng(canvas), `${p.id}.png`);

    return (
        <Modal title={`Label for ${title(p.id)}`} onClose={p.onClose}>
            <div ref={host} />
            {error && <p class="muted">{error}</p>}
            <p class="hint">
                {w}x{h} mm, {fromPrinter ? `read from the printer over ${info!.transport}` : "from settings"}.
                {info === null ? " Looking for the printer..." : info.ok ? "" : ` Printer: ${info.error}`}
            </p>
            <div class="row">
                <button class="btn primary" disabled={!info?.ok || busy || !canvas} onClick={print}>
                    {busy ? "Printing..." : "Print"}
                </button>
                <button class="btn" disabled={!canvas} onClick={download}>Download PNG</button>
            </div>
            <p class="hint">A downloaded label prints with: uv run ~/thermal-printer/tprint.py -i {p.id}.png</p>
        </Modal>
    );
}

// ---- items ----
export function ItemForm(p: { item: Item; onChange: (i: Item) => void; bags?: Bag[] }) {
    const set = (patch: Partial<Item>) => p.onChange({ ...p.item, ...patch });
    const used = new Set([...TYPES, ...store.data.items.map((i) => i.type).filter(Boolean)]);
    const vendor = p.item.source === "digikey" ? "DigiKey PN" : p.item.source === "mouser" ? "Mouser PN"
        : p.item.source === "lcsc" ? "LCSC PN" : "Vendor PN";
    return (
        <div class="grid">
            <Field label="Type">
                <input list="qr-sort-types" value={p.item.type} onInput={(e) => set({ type: val(e) })} />
                <datalist id="qr-sort-types">{[...used].sort().map((t) => <option value={t} />)}</datalist>
            </Field>
            <Field label="Name / description">
                <input value={p.item.name} onInput={(e) => set({ name: val(e) })} />
            </Field>
            <Field label="Manufacturer PN">
                <input value={p.item.mpn} onInput={(e) => set({ mpn: val(e) })} class="mono" />
            </Field>
            <Field label={vendor}>
                <input value={p.item.vendorPn} onInput={(e) => set({ vendorPn: val(e) })} class="mono" />
            </Field>
            <Field label="Quantity">
                <input type="number" inputMode="numeric" min="0" value={p.item.qty ?? ""}
                    onInput={(e) => set({ qty: val(e) === "" ? null : Number(val(e)) })} />
            </Field>
            <Field label="Date code">
                <input value={p.item.dateCode} onInput={(e) => set({ dateCode: val(e) })} />
            </Field>
            <Field label="Lot">
                <input value={p.item.lot} onInput={(e) => set({ lot: val(e) })} />
            </Field>
            <Field label="Country">
                <input value={p.item.country} onInput={(e) => set({ country: val(e) })} />
            </Field>
            {p.bags && (
                <Field label="Bag">
                    <select value={p.item.bagId ?? ""} onChange={(e) => set({ bagId: val(e) || null })}>
                        <option value="">(no bag)</option>
                        {p.bags.map((b) => <option value={b.id}>{display(b)}</option>)}
                    </select>
                </Field>
            )}
            <Field label="Notes" wide>
                <textarea rows={2} value={p.item.notes} onInput={(e) => set({ notes: val(e) })} />
            </Field>
        </div>
    );
}

/** Object URL for an item's stored photo, revoked on unmount. */
export function usePhotoUrl(itemId: string | null, enabled: boolean): string | null {
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        if (!itemId || !enabled) {
            setUrl(null);
            return;
        }
        let u: string | null = null;
        store.db.getPhoto(itemId).then((blob) => {
            if (blob) {
                u = URL.createObjectURL(blob);
                setUrl(u);
            }
        });
        return () => {
            if (u) {
                URL.revokeObjectURL(u);
            }
        };
    }, [itemId, enabled]);
    return url;
}

export function Thumb(p: { item: Item }) {
    const url = usePhotoUrl(p.item.id, p.item.hasPhoto);
    return url ? <img class="thumb" src={url} alt="" /> : <div class="thumb" />;
}

export function BlobImage(p: { blob: Blob; class?: string }) {
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        const u = URL.createObjectURL(p.blob);
        setUrl(u);
        return () => URL.revokeObjectURL(u);
    }, [p.blob]);
    return url ? <img class={p.class ?? "photo"} src={url} alt="" /> : null;
}
