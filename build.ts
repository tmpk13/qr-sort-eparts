// Bundles the app into dist/ and copies the static files, the barcode decoder's wasm and the text
// reader (tesseract.js worker, engine and English data) so the app needs no network.
import { watch } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";

const watching = process.argv.includes("--watch");
const outdir = "dist";

async function build(): Promise<boolean> {
    await rm(outdir, { recursive: true, force: true });
    await mkdir(outdir, { recursive: true });
    const result = await Bun.build({
        entrypoints: ["src/main.tsx", "src/decode.worker.ts"],
        outdir,
        target: "browser",
        format: "esm",
        // The text reader is imported on first use; splitting keeps it out of the main bundle.
        splitting: true,
        naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
        minify: !watching && !process.env.NOMINIFY,
        sourcemap: "linked",
    });
    for (const log of result.logs) {
        console.error(log);
    }
    if (!result.success) {
        return false;
    }
    await cp("static", outdir, { recursive: true });
    await cp("node_modules/zxing-wasm/dist/reader/zxing_reader.wasm", `${outdir}/zxing_reader.wasm`);
    await mkdir(`${outdir}/ocr`);
    await cp("node_modules/tesseract.js/dist/worker.min.js", `${outdir}/ocr/worker.min.js`);
    // The worker picks one of these by the browser's SIMD support; LSTM-only matches OEM 1.
    for (const core of ["tesseract-core-lstm", "tesseract-core-simd-lstm", "tesseract-core-relaxedsimd-lstm"]) {
        await cp(`node_modules/tesseract.js-core/${core}.wasm.js`, `${outdir}/ocr/${core}.wasm.js`);
    }
    await cp("node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", `${outdir}/ocr/eng.traineddata.gz`);
    console.log(`built ${outdir}/ at ${new Date().toLocaleTimeString()}`);
    return true;
}

const ok = await build();
if (!watching) {
    process.exit(ok ? 0 : 1);
}

let timer: ReturnType<typeof setTimeout> | undefined;
for (const dir of ["src", "static"]) {
    watch(dir, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => void build(), 150);
    });
}
console.log("watching src/ and static/");
