// Label images for bags and boxes: a QR code with the id and name beside it (below it on tall
// labels), drawn at the printer's 8 dots per mm as pure black and white.
import QRCode from "qrcode";

export const DOTS_PER_MM = 8;
export const MARGIN = 8; // dots

export interface LabelSpec {
    payload: string; // QR content
    title: string; // "BAG 7"
    subtitle: string; // the name, may be empty
    wMm: number;
    hMm: number;
}

export interface Layout {
    w: number;
    h: number;
    qr: { x: number; y: number; side: number; scale: number; modules: number };
    text: { x: number; y: number; w: number; h: number };
}

/** Where the QR code and the text go, in dots. Throws when the QR code cannot get 2 dots per module. */
export function layout(spec: LabelSpec, modules: number): Layout {
    const w = Math.round(spec.wMm * DOTS_PER_MM);
    const h = Math.round(spec.hMm * DOTS_PER_MM);
    const avail = Math.min(w, h) - 2 * MARGIN;
    const n = modules + 4; // two quiet modules each side
    const scale = Math.floor(avail / n);
    if (scale < 2) {
        throw new Error(`QR code too large for a ${spec.wMm}x${spec.hMm} mm label`);
    }
    const side = n * scale;
    if (w >= h) {
        const x = MARGIN + side;
        return { w, h, qr: { x: MARGIN, y: Math.floor((h - side) / 2), side, scale, modules },
            text: { x, y: 0, w: w - x - MARGIN, h } };
    }
    const y = MARGIN + side;
    return { w, h, qr: { x: Math.floor((w - side) / 2), y: MARGIN, side, scale, modules },
        text: { x: 0, y, w, h: h - y - MARGIN } };
}

export function qrModules(payload: string): { size: number; data: Uint8Array } {
    const q = QRCode.create(payload, { errorCorrectionLevel: "M" });
    return { size: q.modules.size, data: q.modules.data as unknown as Uint8Array };
}

/** Lines of text that fit a width at a font size, breaking only between words. */
export function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
    const lines: string[] = [];
    for (const para of text.split("\n")) {
        let line = "";
        for (const word of para.split(/\s+/).filter(Boolean)) {
            const next = line ? `${line} ${word}` : word;
            if (line && ctx.measureText(next).width > width) {
                lines.push(line);
                line = word;
            } else {
                line = next;
            }
        }
        lines.push(line);
    }
    return lines;
}

interface Fit {
    px: number;
    lines: string[];
}

const LINE = 1.15; // line height as a multiple of the font size
const GAP = 4; // dots between title and subtitle

/** The largest font, down to minPx, whose wrapped lines fit the width and the height. */
function fitBlock(ctx: CanvasRenderingContext2D, text: string, width: number, height: number, maxPx: number,
    minPx: number, weight: string): Fit {
    for (let px = Math.max(maxPx, minPx); px >= minPx; px -= 1) {
        ctx.font = `${weight} ${px}px sans-serif`;
        const lines = wrap(ctx, text, width);
        if (lines.length * px * LINE <= height && lines.every((l) => ctx.measureText(l).width <= width)) {
            return { px, lines };
        }
    }
    ctx.font = `${weight} ${minPx}px sans-serif`;
    return { px: minPx, lines: wrap(ctx, text, width) };
}

/** The largest font, down to minPx, that keeps the text on one line; null when none does. */
function fitLine(ctx: CanvasRenderingContext2D, text: string, width: number, maxPx: number, minPx: number,
    weight: string): Fit | null {
    for (let px = maxPx; px >= minPx; px -= 1) {
        ctx.font = `${weight} ${px}px sans-serif`;
        if (ctx.measureText(text).width <= width) {
            return { px, lines: [text] };
        }
    }
    return null;
}

export function renderLabel(spec: LabelSpec): HTMLCanvasElement {
    const modules = qrModules(spec.payload);
    const lay = layout(spec, modules.size);
    const canvas = document.createElement("canvas");
    canvas.width = lay.w;
    canvas.height = lay.h;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, lay.w, lay.h);
    ctx.fillStyle = "#000";
    const { x: qx, y: qy, scale } = lay.qr;
    for (let r = 0; r < modules.size; r++) {
        for (let c = 0; c < modules.size; c++) {
            if (modules.data[r * modules.size + c]) {
                ctx.fillRect(qx + (c + 2) * scale, qy + (r + 2) * scale, scale, scale);
            }
        }
    }
    const t = lay.text;
    const width = t.w - MARGIN;
    const height = t.h - 2 * MARGIN;
    const maxTitle = Math.floor(t.h * 0.42);
    // The title stays on one line while it can be at least 2.5 mm tall, otherwise it wraps.
    const title = fitLine(ctx, spec.title, width, maxTitle, 20, "bold")
        ?? fitBlock(ctx, spec.title, width, height, maxTitle, 12, "bold");
    const titleH = title.lines.length * title.px * LINE;
    let sub: Fit | null = null;
    if (spec.subtitle.trim()) {
        const room = height - titleH - GAP;
        if (room >= 10 * LINE) {
            sub = fitBlock(ctx, spec.subtitle, width, room, Math.min(Math.floor(title.px * 0.7), Math.floor(room / LINE)),
                10, "normal");
        }
    }
    const total = titleH + (sub ? GAP + sub.lines.length * sub.px * LINE : 0);
    const bottom = t.y + t.h - MARGIN;
    let y = t.y + MARGIN + Math.max(0, (height - total) / 2);
    ctx.textBaseline = "top";
    ctx.textAlign = lay.w >= lay.h ? "left" : "center";
    const tx = lay.w >= lay.h ? t.x + MARGIN / 2 : t.x + t.w / 2;
    const draw = (fit: Fit, weight: string) => {
        ctx.font = `${weight} ${fit.px}px sans-serif`;
        for (const line of fit.lines) {
            if (y + fit.px * LINE > bottom + 1) {
                return;
            }
            ctx.fillText(line, tx, y);
            y += fit.px * LINE;
        }
    };
    draw(title, "bold");
    if (sub) {
        y += GAP;
        draw(sub, "normal");
    }
    threshold(ctx, lay.w, lay.h);
    return canvas;
}

/** Anti-aliased text becomes crisp black and white, which prints cleaner than a dither. */
export function threshold(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 < 140 ? 0 : 255;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
}

export function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"));
}
