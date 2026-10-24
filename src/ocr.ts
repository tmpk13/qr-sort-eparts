// Reading a label's printed text with tesseract.js. Its code, engine and English data load only
// the first time text is read, from ocr/ next to the page, so the app stays offline-capable.
import type { TextLine } from "./parse.ts";

interface Line {
    text: string;
    confidence: number;
}

interface OcrWorker {
    recognize(image: Blob | HTMLCanvasElement, options?: object, output?: object): Promise<{
        data: { blocks: { paragraphs: { lines: Line[] }[] }[] | null };
    }>;
}

let worker: Promise<OcrWorker> | null = null;

function load(): Promise<OcrWorker> {
    worker ??= import("tesseract.js").then((mod) => {
        // A split-off CommonJS package arrives as its default export only.
        const { createWorker } = mod.default ?? mod;
        const base = new URL("ocr/", location.href).href;
        // OEM 1 is the LSTM engine alone, which is all the bundled core and language data carry.
        return createWorker("eng", 1, { workerPath: `${base}worker.min.js`, corePath: base, langPath: base,
            workerBlobURL: false, gzip: true }) as unknown as OcrWorker;
    }).catch((err) => {
        worker = null;
        throw err;
    });
    return worker;
}

/** Starts loading the engine ahead of the first read. */
export function warmUp(): void {
    void load().catch(() => undefined);
}

/** The text lines in the image, each with tesseract's confidence (0 to 100). */
export async function readText(image: Blob | HTMLCanvasElement): Promise<TextLine[]> {
    const w = await load();
    const { data } = await w.recognize(image, {}, { blocks: true, text: false });
    const lines: TextLine[] = [];
    for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs) {
            for (const line of para.lines) {
                const text = line.text.trim();
                if (text) {
                    lines.push({ text, confidence: line.confidence });
                }
            }
        }
    }
    return lines;
}
