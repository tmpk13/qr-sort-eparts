// Barcode decoding off the main thread.
import { prepareZXingModule, readBarcodes, type ReadResult } from "zxing-wasm/reader";

prepareZXingModule({
    overrides: {
        locateFile: (path: string, prefix: string) =>
            path.endsWith(".wasm") ? new URL("zxing_reader.wasm", self.location.href).href : prefix + path,
    },
});

interface Request {
    id: number;
    image?: ImageData;
    blob?: Blob;
    formats: string[];
}

self.onmessage = async (e: MessageEvent<Request>) => {
    const { id, image, blob, formats } = e.data;
    let results: ReadResult[] = [];
    try {
        results = await readBarcodes((image ?? blob)!, {
            formats: formats as never,
            tryHarder: true,
            tryRotate: true,
            tryInvert: false,
            maxNumberOfSymbols: 4,
            textMode: "Plain",
        });
    } catch (err) {
        console.error("decode failed", err);
    }
    self.postMessage({
        id,
        results: results.filter((r) => r.isValid && r.text).map((r) => ({
            text: r.text,
            format: r.format,
            corners: [r.position.topLeft, r.position.topRight, r.position.bottomRight, r.position.bottomLeft],
        })),
    });
};
