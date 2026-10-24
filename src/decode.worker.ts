// Barcode decoding off the main thread.
import { prepareZXingModule, readBarcodes, type ReaderOptions, type ReadResult } from "zxing-wasm/reader";

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
    close: boolean; // an enlarged region or a still: worth more effort than a live frame
}

function corners(r: ReadResult) {
    return [r.position.topLeft, r.position.topRight, r.position.bottomRight, r.position.bottomLeft];
}

self.onmessage = async (e: MessageEvent<Request>) => {
    const { id, image, blob, formats, close } = e.data;
    const input = (image ?? blob)!;
    const base: ReaderOptions = {
        formats: formats as never,
        tryHarder: true,
        tryRotate: true,
        tryInvert: close,
        maxNumberOfSymbols: 8,
        textMode: "Plain",
        // Symbols that were found but did not decode come back too, so the caller can look closer.
        returnErrors: !close,
    };
    let results: ReadResult[] = [];
    try {
        results = await readBarcodes(input, base);
        if (close && !results.some((r) => r.isValid)) {
            results = await readBarcodes(input, { ...base, tryDenoise: true, binarizer: "GlobalHistogram" });
        }
    } catch (err) {
        console.error("decode failed", err);
    }
    self.postMessage({
        id,
        results: results.filter((r) => r.isValid && r.text).map((r) => ({ text: r.text, format: r.format, corners: corners(r) })),
        misses: results.filter((r) => !r.isValid).map((r) => ({ text: "", format: r.format, corners: corners(r) })),
    });
};
