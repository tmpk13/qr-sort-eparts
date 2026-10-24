// Camera access, frame decoding in a worker, and the auto-capture rule that fires once per bag.
import { joinLinear, parseIso15434 } from "./parse.ts";

export interface Point {
    x: number;
    y: number;
}

export interface Detection {
    text: string;
    format: string;
    corners: Point[];
}

/** Part of the visible picture, each edge as a fraction of its width or height. */
export interface Region {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

export const LINEAR_FORMATS = ["Code128", "Code39", "Code93"];
export const FORMATS_PARTS = ["DataMatrix", "QRCode", "PDF417", ...LINEAR_FORMATS];
export const FORMATS_LABELS = ["QRCode"];

export function isLinear(d: Pick<Detection, "format">): boolean {
    return LINEAR_FORMATS.includes(d.format);
}

/** The corners' bounding box widened by margin (a fraction of its size), clamped to the frame. */
export function boundsOf(corners: Point[], width: number, height: number, margin = 0.4): Region | null {
    if (!corners.length || !width || !height) {
        return null;
    }
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const m = Math.max(x1 - x0, y1 - y0) * margin;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const r = { x0: clamp((x0 - m) / width), y0: clamp((y0 - m) / height), x1: clamp((x1 + m) / width),
        y1: clamp((y1 + m) / height) };
    return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
}

/** A point in an image of the region (imageW by imageH) as a point in the frame. */
export function fromRegion(p: Point, r: Region, imageW: number, imageH: number, frame: FrameInfo): Point {
    return {
        x: (r.x0 + (p.x / imageW) * (r.x1 - r.x0)) * frame.width,
        y: (r.y0 + (p.y / imageH) * (r.y1 - r.y0)) * frame.height,
    };
}

export interface ZoomRange {
    min: number;
    max: number;
    step: number;
}

export const DIGITAL_ZOOM: ZoomRange = { min: 1, max: 4, step: 0.25 };

export class Camera {
    stream: MediaStream | null = null;
    /** Zoom done by cropping: frames, snapshots and the picture on screen show the middle 1/zoom. */
    digitalZoom = 1;
    private canvas = document.createElement("canvas");

    constructor(public video: HTMLVideoElement) {}

    async start(deviceId = ""): Promise<void> {
        this.stop();
        // A sharper picture gives small bag codes more pixels; frames are scaled down for decoding.
        const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
        const video: MediaTrackConstraints = deviceId
            ? { deviceId: { exact: deviceId }, ...size }
            : { facingMode: { ideal: "environment" }, ...size };
        this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        this.video.srcObject = this.stream;
        await this.video.play();
    }

    stop(): void {
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        this.video.srcObject = null;
    }

    get ready(): boolean {
        return this.stream !== null && this.video.readyState >= 2 && this.video.videoWidth > 0;
    }

    private get track(): MediaStreamTrack | null {
        return this.stream?.getVideoTracks()[0] ?? null;
    }

    /** The camera's own zoom range (phones mostly), or null when zooming means cropping. */
    zoomRange(): ZoomRange | null {
        const caps = this.track?.getCapabilities?.() as { zoom?: { min: number; max: number; step?: number } } | undefined;
        const z = caps?.zoom;
        return z && z.max > z.min ? { min: z.min, max: z.max, step: z.step || 0.1 } : null;
    }

    async setZoom(zoom: number): Promise<void> {
        const range = this.zoomRange();
        if (range) {
            try {
                const z = Math.min(range.max, Math.max(range.min, zoom));
                await this.track!.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] });
                this.digitalZoom = 1;
                return;
            } catch {
                // the camera reported a zoom it does not accept; crop instead
            }
        }
        this.digitalZoom = Math.min(DIGITAL_ZOOM.max, Math.max(1, zoom));
    }

    /** The visible part of the video, in video pixels. */
    private view(): { sx: number; sy: number; sw: number; sh: number } {
        const vw = this.video.videoWidth;
        const vh = this.video.videoHeight;
        const sw = vw / this.digitalZoom;
        const sh = vh / this.digitalZoom;
        return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
    }

    private draw(sx: number, sy: number, sw: number, sh: number, w: number, h: number): ImageData {
        this.canvas.width = w;
        this.canvas.height = h;
        const ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(this.video, sx, sy, sw, sh, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h);
    }

    /** The visible picture, scaled down to at most maxWidth for decoding. */
    frame(maxWidth = 1280): ImageData | null {
        if (!this.ready) {
            return null;
        }
        const v = this.view();
        const scale = Math.min(1, maxWidth / v.sw);
        return this.draw(v.sx, v.sy, v.sw, v.sh, Math.round(v.sw * scale), Math.round(v.sh * scale));
    }

    /** A region of the visible picture at full resolution, enlarged up to 3x so its longer side is minSide. */
    region(r: Region, minSide = 800): ImageData | null {
        if (!this.ready) {
            return null;
        }
        const v = this.view();
        const sx = v.sx + r.x0 * v.sw;
        const sy = v.sy + r.y0 * v.sh;
        const sw = (r.x1 - r.x0) * v.sw;
        const sh = (r.y1 - r.y0) * v.sh;
        const scale = Math.min(3, Math.max(1, minSide / Math.max(sw, sh)));
        return this.draw(sx, sy, sw, sh, Math.max(1, Math.round(sw * scale)), Math.max(1, Math.round(sh * scale)));
    }

    /** The visible picture at full resolution as a JPEG. */
    snapshot(quality = 0.85): Promise<Blob | null> {
        if (!this.ready) {
            return Promise.resolve(null);
        }
        const v = this.view();
        const c = document.createElement("canvas");
        c.width = Math.round(v.sw);
        c.height = Math.round(v.sh);
        c.getContext("2d")!.drawImage(this.video, v.sx, v.sy, v.sw, v.sh, 0, 0, c.width, c.height);
        return new Promise((resolve) => c.toBlob(resolve, "image/jpeg", quality));
    }

    /** A still at the camera's full photo resolution where the browser can take one (ImageCapture). */
    async still(): Promise<Blob | null> {
        const Capture = (globalThis as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(s?: object): Promise<Blob> } })
            .ImageCapture;
        const track = this.track;
        if (!Capture || !track) {
            return null;
        }
        const cap = new Capture(track);
        try {
            return await cap.takePhoto({ fillLightMode: "off" });
        } catch {
            try {
                return await cap.takePhoto();
            } catch {
                return null;
            }
        }
    }
}

export interface Decoded {
    results: Detection[];
    misses: Detection[]; // codes found in the picture that did not read, with an empty text
}

export class Decoder {
    private worker: Worker;
    private pending = new Map<number, (r: Decoded) => void>();
    private seq = 0;

    constructor(url = "decode.worker.js") {
        this.worker = new Worker(url, { type: "module" });
        this.worker.onmessage = (e: MessageEvent<{ id: number } & Decoded>) => {
            this.pending.get(e.data.id)?.({ results: e.data.results, misses: e.data.misses });
            this.pending.delete(e.data.id);
        };
    }

    /**
     * Decodes a frame (its pixel buffer is handed to the worker) or an image file. A close look
     * (an enlarged region, a still) tries harder: inverted, denoised, another binarizer.
     */
    decode(input: ImageData | Blob, formats: string[], close = false): Promise<Decoded> {
        const id = ++this.seq;
        return new Promise((resolve) => {
            this.pending.set(id, resolve);
            if (input instanceof ImageData) {
                this.worker.postMessage({ id, image: input, formats, close }, [input.data.buffer]);
            } else {
                this.worker.postMessage({ id, blob: input, formats, close: true });
            }
        });
    }

    close(): void {
        this.worker.terminate();
        this.pending.clear();
    }
}

export interface FrameInfo {
    width: number;
    height: number;
}

/**
 * Decodes frames back to back, at most about ten a second. When a code is seen but does not read,
 * it looks again at that spot in full resolution, and after a few such frames takes a still.
 */
export class Scanner {
    running = false;
    useStills = true;
    private formats: string[];
    private missStreak = 0;
    private lastStill = 0;

    constructor(private camera: Camera, private decoder: Decoder, formats: string[],
        private onFrame: (dets: Detection[], frame: FrameInfo, misses: Detection[]) => void) {
        this.formats = formats;
    }

    setFormats(formats: string[]): void {
        this.formats = formats;
    }

    start(): void {
        if (!this.running) {
            this.running = true;
            void this.loop();
        }
    }

    stop(): void {
        this.running = false;
    }

    private async loop(): Promise<void> {
        while (this.running) {
            const img = this.camera.frame();
            if (!img) {
                await sleep(100);
                continue;
            }
            const frame = { width: img.width, height: img.height };
            const t0 = performance.now();
            const { results, misses } = await this.decoder.decode(img, this.formats);
            const dets = results.some((d) => !isLinear(d)) || !misses.length ? results
                : [...results, ...await this.lookCloser(misses, frame)];
            if (!this.running) {
                break;
            }
            this.onFrame(dets, frame, dets.some((d) => !isLinear(d)) ? [] : misses);
            await sleep(Math.max(10, 100 - (performance.now() - t0)));
        }
    }

    private async lookCloser(misses: Detection[], frame: FrameInfo): Promise<Detection[]> {
        const found: Detection[] = [];
        for (const miss of misses.slice(0, 2)) {
            const r = boundsOf(miss.corners, frame.width, frame.height);
            const img = r && this.camera.region(r);
            if (!r || !img) {
                continue;
            }
            const [w, h] = [img.width, img.height];
            const again = await this.decoder.decode(img, this.formats, true);
            found.push(...again.results.map((d) => ({ ...d, corners: d.corners.map((p) => fromRegion(p, r, w, h, frame)) })));
            if (found.length) {
                break;
            }
        }
        this.missStreak = found.length ? 0 : this.missStreak + 1;
        const now = performance.now();
        if (!found.length && this.useStills && this.missStreak >= 4 && now - this.lastStill > 2500) {
            this.lastStill = now;
            const still = await this.camera.still();
            if (still) {
                // A still's framing differs from the video's, so its codes come without an outline.
                found.push(...(await this.decoder.decode(still, this.formats)).results.map((d) => ({ ...d, corners: [] })));
            }
        }
        return found;
    }
}

export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fires once when a code has been in frame for a few consecutive frames, then stays quiet until
 * the frame has been empty for releaseMs (the bag was taken away) or a different code shows up.
 */
export class AutoCapture {
    private held: string | null = null;
    private candidate: string | null = null;
    private count = 0;
    private lastSeen = 0;

    constructor(private settleFrames = 2, private releaseMs = 1500) {}

    /** Call with the code seen in this frame (or null); returns the code to capture, if any. */
    feed(code: string | null, now: number): string | null {
        if (code === null) {
            this.candidate = null;
            this.count = 0;
            if (this.held !== null && now - this.lastSeen > this.releaseMs) {
                this.held = null;
            }
            return null;
        }
        this.lastSeen = now;
        if (code === this.held) {
            return null;
        }
        if (code === this.candidate) {
            this.count += 1;
        } else {
            this.candidate = code;
            this.count = 1;
        }
        if (this.count >= this.settleFrames) {
            this.held = code;
            this.candidate = null;
            this.count = 0;
            return code;
        }
        return null;
    }

    /** Forget the held code, so the same bag captures again (after a manual capture, say). */
    reset(): void {
        this.held = null;
        this.candidate = null;
        this.count = 0;
    }

    get holding(): string | null {
        return this.held;
    }
}

/** What one frame offers for capture. */
export interface Candidate {
    key: string; // compared between frames by the auto capture
    text: string; // the code to parse
    dets: Detection[]; // the codes it came from
}

/**
 * Prefer a parts code over one of our own labels, Data Matrix over QR, any 2D code over 1D ones.
 * 1D codes count only together, when their data identifiers name a part.
 */
export function pickCode(dets: Detection[]): Candidate | null {
    const matrix = dets.filter((d) => !isLinear(d));
    if (matrix.length) {
        const rank = (d: Detection) => (d.text.startsWith("qrsort:") ? 2 : 0) + (d.format === "DataMatrix" ? 0 : 1);
        const d = [...matrix].sort((a, b) => rank(a) - rank(b))[0];
        return { key: d.text, text: d.text, dets: [d] };
    }
    const linear = dets.filter(isLinear);
    const joined = joinLinear(linear.map((d) => d.text));
    if (!joined) {
        return null;
    }
    // Keyed by the part, so a frame that reads one more of the label's barcodes is still the same bag.
    const p = parseIso15434(joined)!;
    return { key: `linear:${p.mpn || p.vendorPn}`, text: joined, dets: linear };
}
