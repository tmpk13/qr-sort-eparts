// Camera access, frame decoding in a worker, and the auto-capture rule that fires once per bag.

export interface Point {
    x: number;
    y: number;
}

export interface Detection {
    text: string;
    format: string;
    corners: Point[];
}

export const FORMATS_PARTS = ["DataMatrix", "QRCode"];
export const FORMATS_LABELS = ["QRCode"];

export class Camera {
    stream: MediaStream | null = null;
    private canvas = document.createElement("canvas");

    constructor(public video: HTMLVideoElement) {}

    async start(deviceId = ""): Promise<void> {
        this.stop();
        const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
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

    /** The current frame, scaled down to at most maxWidth for decoding. */
    frame(maxWidth = 1280): ImageData | null {
        if (!this.ready) {
            return null;
        }
        const scale = Math.min(1, maxWidth / this.video.videoWidth);
        const w = Math.round(this.video.videoWidth * scale);
        const h = Math.round(this.video.videoHeight * scale);
        this.canvas.width = w;
        this.canvas.height = h;
        const ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(this.video, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h);
    }

    /** The current frame at full resolution as a JPEG. */
    snapshot(quality = 0.85): Promise<Blob | null> {
        if (!this.ready) {
            return Promise.resolve(null);
        }
        const c = document.createElement("canvas");
        c.width = this.video.videoWidth;
        c.height = this.video.videoHeight;
        c.getContext("2d")!.drawImage(this.video, 0, 0);
        return new Promise((resolve) => c.toBlob(resolve, "image/jpeg", quality));
    }
}

export class Decoder {
    private worker: Worker;
    private pending = new Map<number, (r: Detection[]) => void>();
    private seq = 0;

    constructor(url = "decode.worker.js") {
        this.worker = new Worker(url, { type: "module" });
        this.worker.onmessage = (e: MessageEvent<{ id: number; results: Detection[] }>) => {
            this.pending.get(e.data.id)?.(e.data.results);
            this.pending.delete(e.data.id);
        };
    }

    /** Decodes a frame (its pixel buffer is handed to the worker) or an image file. */
    decode(input: ImageData | Blob, formats: string[]): Promise<Detection[]> {
        const id = ++this.seq;
        return new Promise((resolve) => {
            this.pending.set(id, resolve);
            if (input instanceof ImageData) {
                this.worker.postMessage({ id, image: input, formats }, [input.data.buffer]);
            } else {
                this.worker.postMessage({ id, blob: input, formats });
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

/** Decodes frames back to back, at most about ten a second. */
export class Scanner {
    running = false;
    private formats: string[];

    constructor(private camera: Camera, private decoder: Decoder, formats: string[],
        private onFrame: (dets: Detection[], frame: FrameInfo) => void) {
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
            const dets = await this.decoder.decode(img, this.formats);
            if (!this.running) {
                break;
            }
            this.onFrame(dets, frame);
            await sleep(Math.max(10, 100 - (performance.now() - t0)));
        }
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

/** Prefer a parts code over one of our own labels, and Data Matrix over QR. */
export function pickCode(dets: Detection[]): Detection | null {
    if (!dets.length) {
        return null;
    }
    const rank = (d: Detection) => (d.text.startsWith("qrsort:") ? 2 : 0) + (d.format === "DataMatrix" ? 0 : 1);
    return [...dets].sort((a, b) => rank(a) - rank(b))[0];
}
