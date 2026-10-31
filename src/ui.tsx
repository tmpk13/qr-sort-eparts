// Shared components: toasts, form bits, the camera panel with its overlay, the label dialog and
// the item form.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { canvasPng, renderLabel } from "./label.ts";
import { display, itemTag, qrPayload, title, unidentifiedKind, type Bag, type Item } from "./model.ts";
import { TYPES } from "./parse.ts";
import { downloadBlob, printPng, printerInfo, type PrinterInfo } from "./printer.ts";
import { Camera, Decoder, DIGITAL_ZOOM, Scanner, type Detection, type FrameInfo, type ZoomRange } from "./scanner.ts";
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
/** A big, short-lived sign over the camera after a capture. */
export interface Flash {
    kind: "ok" | "unknown" | "nocode" | "elsewhere" | "err";
    text: string;
    at: number; // a new value restarts the animation
}

export interface CameraPanelProps {
    active: boolean;
    onToggle: () => void;
    formats: string[];
    onFrame: (dets: Detection[], camera: Camera, misses: Detection[]) => void;
    onReady?: (camera: Camera, decoder: Decoder) => void;
    onRunning?: (running: boolean) => void;
    highlight?: (d: Detection) => string; // outline color per code
    status?: string;
    flash?: Flash | null;
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

function drawOverlay(canvas: HTMLCanvasElement, dets: Detection[], misses: Detection[], frame: FrameInfo,
    highlight?: (d: Detection) => string): void {
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = Math.max(2, frame.width / 250);
    ctx.lineJoin = "round";
    const outline = (d: Detection, color: string, dash: number[]) => {
        if (d.corners.length < 2) {
            return;
        }
        ctx.strokeStyle = color;
        ctx.setLineDash(dash);
        ctx.beginPath();
        d.corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
        ctx.closePath();
        ctx.stroke();
    };
    // Found but not read yet: dashed orange, so it is clear the camera has it and needs a better look.
    misses.forEach((d) => outline(d, "#cb4b16", [ctx.lineWidth * 3, ctx.lineWidth * 2]));
    dets.forEach((d) => outline(d, highlight?.(d) ?? "#268bd2", []));
    ctx.setLineDash([]);
}

function FlashSign(p: { flash: Flash }) {
    const d = p.flash.kind === "ok" ? "M20 55 L42 77 L82 28"
        : p.flash.kind === "elsewhere" ? "M15 50 H80 M55 25 L80 50 L55 75"
            : p.flash.kind === "err" ? "M25 25 L75 75 M75 25 L25 75"
                : p.flash.kind === "nocode" // a camera
                    ? "M10 32 H30 L38 20 H62 L70 32 H90 V84 H10 Z M39 58 A11 11 0 1 0 61 58 A11 11 0 1 0 39 58"
                    : "M35 35 Q35 18 50 18 Q65 18 65 34 Q65 46 50 52 V62 M50 80 V82";
    return (
        <div key={p.flash.at} class={`flash ${p.flash.kind}`} role="status">
            <svg viewBox="0 0 100 100" aria-hidden="true">
                <path d={d} fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round"
                    stroke-linejoin="round" />
            </svg>
            <div>{p.flash.text}</div>
        </div>
    );
}

export function CameraPanel(p: CameraPanelProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const props = useRef(p);
    props.current = p;
    const rig = useRef<{ camera: Camera; decoder: Decoder; scanner: Scanner } | null>(null);
    const [s] = useSettings();
    const [error, setError] = useState("");
    const [running, setRunningState] = useState(false);
    const [zoomRange, setZoomRange] = useState<ZoomRange>(DIGITAL_ZOOM);
    const [digital, setDigital] = useState(1);
    const setRunning = (on: boolean) => {
        setRunningState(on);
        props.current.onRunning?.(on);
    };

    const applyZoom = async (z: number) => {
        const camera = rig.current?.camera;
        if (camera?.ready) {
            await camera.setZoom(z);
            setDigital(camera.digitalZoom);
        }
    };

    useEffect(() => {
        const camera = new Camera(videoRef.current!);
        const decoder = new Decoder();
        const scanner = new Scanner(camera, decoder, props.current.formats, (dets, frame, misses) => {
            drawOverlay(canvasRef.current!, dets, misses, frame, props.current.highlight);
            props.current.onFrame(dets, camera, misses);
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
        if (rig.current) {
            rig.current.scanner.useStills = s.stills;
        }
    }, [s.stills]);

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
        })().then(async () => {
            if (cancelled) {
                r.camera.stop();
                return;
            }
            setZoomRange(r.camera.zoomRange() ?? DIGITAL_ZOOM);
            await applyZoom(settings.value.zoom);
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

    const zoom = Math.min(zoomRange.max, Math.max(zoomRange.min, s.zoom));
    return (
        <div class="camera">
            <video ref={videoRef} muted playsInline autoPlay
                style={digital > 1 ? `transform: scale(${digital})` : undefined} />
            <canvas ref={canvasRef} />
            {!running && (
                <div class="center">
                    {error ? <span>{error}</span> : p.active
                        ? <span>Starting the camera...</span>
                        : <button class="btn primary" onClick={p.onToggle}>Start camera</button>}
                </div>
            )}
            {running && p.children}
            {running && p.flash && <FlashSign flash={p.flash} />}
            {running && (
                <label class="zoom" title="Zoom">
                    <input type="range" min={zoomRange.min} max={zoomRange.max} step={zoomRange.step} value={zoom}
                        aria-label="Zoom" onInput={(e) => {
                            const z = Number(val(e));
                            settings.set({ zoom: z });
                            void applyZoom(z);
                        }} />
                    <span>{zoom.toFixed(zoom % 1 ? 1 : 0)}x</span>
                </label>
            )}
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
            <Field label="Bag quantity (from the labels)">
                <input type="number" inputMode="numeric" min="0" value={p.item.qty ?? ""}
                    onInput={(e) => set({ qty: val(e) === "" ? null : Number(val(e)) })} />
            </Field>
            <Field label="Current count">
                <input type="number" inputMode="numeric" min="0" value={p.item.count ?? ""}
                    onInput={(e) => set({ count: val(e) === "" ? null : Number(val(e)) })} />
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

/** "x40" for the count on hand, "x40/100" when that differs from the bag quantity. */
export function QtyBadge(p: { item: Item }) {
    const { count, qty } = p.item;
    if (count == null && qty == null) {
        return null;
    }
    const text = count == null ? `bag x${qty}` : qty != null && qty !== count ? `x${count}/${qty}` : `x${count}`;
    return <span class="badge" title="current count / bag quantity">{text}</span>;
}

export function Tag(p: { item: Item }) {
    return <span class="tag mono">{itemTag(p.item)}</span>;
}

/** The marker class of a record waiting to be identified (magenta for codes, violet for photos), else "". */
export function waitingClass(item: Pick<Item, "source">): string {
    const kind = unidentifiedKind(item);
    return kind === "code" ? "unknown" : kind === "photo" ? "nocode" : "";
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
