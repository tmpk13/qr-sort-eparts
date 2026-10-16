// The built app in a real browser whose camera is a clip of a bag code. Runs with E2E=1 only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { chromium, type Browser, type Page } from "playwright";
import { prepareZXingModule, readBarcodes, writeBarcode } from "zxing-wasm/full";
import { DK_OLD } from "./fixtures.ts";
import { makeY4m } from "./y4m.ts";

const enabled = process.env.E2E === "1";
const dist = new URL("../dist/", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "qr-sort-e2e-"));
const shots = new URL("../.screenshots/", import.meta.url).pathname;
const shot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) });

prepareZXingModule({
    overrides: { wasmBinary: await Bun.file("node_modules/zxing-wasm/dist/full/zxing_full.wasm").arrayBuffer() },
});

async function clip(text: string, format: "DataMatrix" | "QRCode"): Promise<string> {
    const written = await writeBarcode(text, { format, scale: 6 });
    const png = PNG.sync.read(Buffer.from(await written.image!.arrayBuffer()));
    const path = join(work, `${format}-${Math.random().toString(36).slice(2)}.y4m`);
    await Bun.write(path, makeY4m(png.width, png.height, png.data, 640, 480, 10));
    return path;
}

function serveDist() {
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            const p = new URL(req.url).pathname;
            if (p === "/api/printer") {
                return Response.json({ ok: false, error: "no printer in the test" }, { status: 503 });
            }
            const f = Bun.file(join(dist, p === "/" ? "index.html" : p.slice(1)));
            return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
        },
    });
    return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

async function launch(video: string, errors: string[]): Promise<{ browser: Browser; page: Page }> {
    const browser = await chromium.launch({
        args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            `--use-file-for-fake-video-capture=${video}`],
    });
    const context = await browser.newContext({ permissions: ["camera"], viewport: { width: 900, height: 1200 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const expected = (text: string) => text.includes("/api/printer") || text.includes("status of 503");
    page.on("console", (m) => m.type() === "error" && !expected(m.text()) && errors.push(m.text()));
    page.on("response", (r) => r.status() >= 400 && !expected(r.url()) && errors.push(`${r.status()} ${r.url()}`));
    return { browser, page };
}

async function loadSample(page: Page, url: string): Promise<void> {
    await page.goto(`${url}/#settings`);
    await page.getByRole("button", { name: "Load sample data" }).click();
    await page.getByText("Sample data loaded").waitFor();
}

describe.skipIf(!enabled)("app in a browser", () => {
    let site: ReturnType<typeof serveDist>;
    beforeAll(() => {
        site = serveDist();
    });
    afterAll(() => site.stop());

    test("browse tree, a scannable label, and auto capture of a DigiKey bag", async () => {
        const errors: string[] = [];
        const { browser, page } = await launch(await clip(DK_OLD, "DataMatrix"), errors);
        try {
            await loadSample(page, site.url);
            await page.getByRole("button", { name: "Browse" }).click();
            const tree = page.locator(".tree");
            await tree.getByText("Shelf 1: Left wall").waitFor();
            expect(await tree.textContent()).toContain("Box 1: Passives");
            expect(await tree.textContent()).toContain("Box 3: Connectors");
            await tree.getByText("Box 1: Passives").click();
            await tree.getByText("Bag 1: 0805 resistors").waitFor();
            await shot(page, "browse");
            await tree.getByRole("button", { name: "Label" }).first().click();
            const canvas = page.locator("canvas.label-preview");
            await canvas.waitFor();
            expect(await canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([320, 240]);
            const dataUrl = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL("image/png"));
            const png = Buffer.from(dataUrl.split(",")[1], "base64");
            const read = await readBarcodes(new Uint8Array(png), { formats: ["QRCode"] });
            expect(read.map((r) => r.text)).toEqual(["qrsort:box:1"]);
            expect(await page.locator(".modal").textContent()).toContain("from settings");
            expect(await page.locator(".modal").textContent()).toContain("Printer: no printer in the test");
            await shot(page, "label");
            await page.getByRole("button", { name: "Close" }).click();

            await page.getByRole("button", { name: "Inventory" }).click();
            expect(await page.locator("select").first().inputValue()).toBe("bag-1");
            await page.getByRole("button", { name: "Start camera" }).first().click();
            const recent = page.locator(".list").last();
            await recent.getByText("SN74LVC1G08DBVR x10").waitFor({ timeout: 20000 });
            await page.waitForTimeout(3000);
            expect(await recent.getByText("SN74LVC1G08DBVR x10").count()).toBe(1);
            expect(await recent.textContent()).toContain("Bag 1: 0805 resistors");
            expect(await recent.locator("img.thumb").count()).toBe(1);
            await shot(page, "inventory");
        } finally {
            await browser.close();
        }
        expect(errors).toEqual([]);
    }, 60000);

    test("finding a part: directions from a box label, box contents, bag placement by label", async () => {
        const errors: string[] = [];
        const { browser, page } = await launch(await clip("qrsort:box:1", "QRCode"), errors);
        try {
            await loadSample(page, site.url);
            await page.getByRole("button", { name: "Find" }).click();
            await page.getByPlaceholder(/Part number/).fill("sn74");
            await page.locator(".list li.clickable").first().click();
            expect(await page.locator(".target").textContent()).toContain("Bag 3: Logic in Box 2: Semiconductors");
            await page.getByRole("button", { name: "Start camera" }).first().click();
            await page.locator(".guide").waitFor({ timeout: 20000 });
            expect(await page.locator(".guide").textContent()).toBe("1 to the right");
            await shot(page, "find");

            await page.getByRole("button", { name: "Clear" }).click();
            const here = page.locator(".panel").last();
            await here.getByText("Box 1: Passives").waitFor();
            expect(await here.textContent()).toContain("Bag 1: 0805 resistors");
            expect(await here.textContent()).toContain("2 items");

            await page.getByRole("button", { name: "Inventory" }).click();
            await page.locator("select").first().selectOption("bag-3");
            await page.getByRole("button", { name: "Start camera" }).first().click();
            await page.getByText("Bag 3: Logic is now in Box 1: Passives").waitFor({ timeout: 20000 });
            await page.getByRole("button", { name: "Browse" }).click();
            await page.locator(".tree").getByText("Box 1: Passives").click();
            await page.locator(".tree").getByText("Bag 3: Logic").waitFor();
        } finally {
            await browser.close();
        }
        expect(errors).toEqual([]);
    }, 60000);
});
