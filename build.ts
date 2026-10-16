// Bundles the app into dist/ and copies the static files and the barcode decoder's wasm.
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
        naming: "[name].[ext]",
        minify: !watching,
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
