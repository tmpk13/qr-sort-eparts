// A Y4M clip Chromium can play as a fake camera: the same frame repeated, the code on gray.
export function makeY4m(imgW: number, imgH: number, rgba: Uint8Array, w: number, h: number, frames: number): Uint8Array {
    const y = new Uint8Array(w * h).fill(160);
    const x0 = (w - imgW) >> 1;
    const y0 = (h - imgH) >> 1;
    for (let r = 0; r < imgH; r++) {
        for (let c = 0; c < imgW; c++) {
            const i = (r * imgW + c) * 4;
            const lum = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
            y[(y0 + r) * w + x0 + c] = Math.round(16 + (lum * 219) / 255);
        }
    }
    const uv = new Uint8Array((w / 2) * (h / 2)).fill(128);
    const header = Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\n`);
    const frame = Buffer.concat([Buffer.from("FRAME\n"), y, uv, uv]);
    return Buffer.concat([header, ...Array<Buffer>(frames).fill(frame)]);
}
