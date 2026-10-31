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

async function clip(text: string, format: "DataMatrix" | "QRCode" | "Code128", scale = 6): Promise<string> {
    const written = await writeBarcode(text, { format, scale });
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
            if (p === "/api/led") {
                return Response.json({ ok: true, attached: false, port: null });
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
    page.on("dialog", (d) => void d.accept());
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
            // The big sign over the picture, then the item in the recent list.
            const sign = page.locator(".camera .flash.ok");
            await sign.waitFor({ timeout: 20000 });
            expect(await sign.textContent()).toBe("Saved I-4 SN74LVC1G08DBVR x10");
            await shot(page, "inventory-saved");
            const recent = page.locator(".list").last();
            await recent.getByText("I-4 SN74LVC1G08DBVR").waitFor();
            await page.waitForTimeout(3000);
            expect(await recent.getByText("I-4 SN74LVC1G08DBVR").count()).toBe(1);
            const row = recent.locator("li").filter({ hasText: "I-4" });
            expect(await row.textContent()).toContain("Bag 1: 0805 resistors");
            expect(await row.textContent()).toContain("x10");
            expect(await recent.locator("img.thumb").count()).toBe(1);
            await shot(page, "inventory");

            // Digital zoom: the fake camera has no zoom of its own, so the picture is scaled.
            const zoom = page.locator(".camera .zoom input");
            await zoom.fill("2");
            expect(await page.locator(".camera video").getAttribute("style")).toContain("scale(2)");
            await zoom.fill("1");

            // The same part into another bag of the box that already holds it: pointed back to that bag.
            await page.getByRole("button", { name: "Stop camera" }).click();
            await page.getByLabel("Current bag").selectOption("bag-2");
            await page.getByRole("button", { name: "Start camera" }).first().click();
            const moved = page.locator(".camera .flash.elsewhere");
            await moved.waitFor({ timeout: 20000 });
            // It is the very same label, so it is not counted twice either.
            expect(await moved.textContent()).toBe("Already counted: I-4 SN74LVC1G08DBVR in Bag 1: 0805 resistors");
            await shot(page, "inventory-elsewhere");
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
            expect(await page.locator(".target").textContent()).toContain("I-3 Single AND gate");
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

            // From a search result straight to the item in Browse.
            await page.getByRole("button", { name: "Find" }).click();
            await page.getByPlaceholder(/Part number/).fill("i-3");
            await page.locator(".list li.clickable").first().getByRole("button", { name: "Open" }).click();
            await page.locator(".modal").getByText("I-3 Single AND gate").waitFor();
            expect(await page.locator(".tree li.focused").textContent()).toContain("I-3");
            await shot(page, "browse-from-find");
        } finally {
            await browser.close();
        }
        expect(errors).toEqual([]);
    }, 60000);

    test("1D barcodes into a batch, the batch into a bag, then cleared", async () => {
        const errors: string[] = [];
        const { browser, page } = await launch(await clip("1PGRM188R71H104KA93D", "Code128", 2), errors);
        try {
            await loadSample(page, site.url);
            await page.getByRole("button", { name: "Inventory" }).click();
            await page.getByLabel("Batch mode").check();
            await page.getByRole("button", { name: "Start camera" }).first().click();
            const sign = page.locator(".camera .flash.ok");
            await sign.waitFor({ timeout: 20000 });
            expect(await sign.textContent()).toBe("Saved I-4 GRM188R71H104KA93D");
            const batch = page.locator(".batch-box");
            await batch.getByText("1 items, 1 not in a bag").waitFor();
            expect(await batch.textContent()).toMatch(/Batch 1 [A-Z2-9]{4}/);
            await shot(page, "batch");
            await page.getByRole("button", { name: "Stop camera" }).click();
            await batch.locator("select").selectOption("bag-2");
            await batch.getByRole("button", { name: "Put batch in bag" }).click();
            await page.getByText("Put 1 items into Bag 2: Ceramic caps").waitFor();
            await batch.getByRole("button", { name: "Clear batch" }).click();
            await page.getByRole("button", { name: "Start batch" }).waitFor();

            await page.getByRole("button", { name: "Browse" }).click();
            await page.locator(".tree").getByText("Box 1: Passives").click();
            await page.locator(".tree").getByText("Bag 2: Ceramic caps").click();
            await page.locator(".tree").getByText("I-4 GRM188R71H104KA93D").waitFor();
            expect(await page.locator(".tree").textContent()).not.toContain("Batches");
        } finally {
            await browser.close();
        }
        expect(errors).toEqual([]);
    }, 60000);

    test("unidentified codes and photos wait apart, in a bag or not; edit mode moves a selection; CSV export", async () => {
        const errors: string[] = [];
        const { browser, page } = await launch(await clip("hello world", "QRCode"), errors);
        try {
            await loadSample(page, site.url);
            await page.getByRole("button", { name: "Inventory" }).click();
            await page.getByRole("button", { name: "Start camera" }).first().click();
            await page.locator(".camera .flash.unknown").waitFor({ timeout: 20000 });
            await page.getByText("1 unidentified code waits to be identified.").waitFor();
            await shot(page, "unidentified");
            await page.getByRole("button", { name: "Photo, no code" }).click();
            await page.locator(".camera .flash.nocode").waitFor();
            await page.getByText("1 unidentified code and 1 photo with no code wait to be identified.").waitFor();
            await shot(page, "photo-no-code");
            await page.getByRole("button", { name: "Stop camera" }).click();

            await page.getByRole("button", { name: "Browse" }).click();
            const unknown = page.locator(".tree details.unknown");
            const photos = page.locator(".tree details.nocode");
            expect(await unknown.textContent()).toContain("I-4 hello world");
            expect(await photos.textContent()).toContain("I-5 (photo, no code)not in a bag");
            await photos.locator("img.thumb").waitFor();
            expect(await page.locator(".tree").getByText("Bag 1: 0805 resistors").count()).toBe(1);

            await page.getByRole("button", { name: "Edit mode" }).click();
            const list = page.locator(".edit-list");
            await list.locator("li.item").filter({ hasText: "I-1 " }).click();
            await list.locator("li.item").filter({ hasText: "I-3 " }).click({ modifiers: ["Shift"] });
            expect(await list.locator("li.selected").count()).toBe(3);
            await shot(page, "edit-mode");
            await page.getByLabel("Move items to bag").selectOption("bag-2");
            await page.getByRole("button", { name: "Move items" }).click();
            await page.getByText("Moved 3 items to Bag 2: Ceramic caps").waitFor();
            // The unidentified records go into the bag too, and stay unidentified under their own headings.
            await list.locator("li.item").filter({ hasText: "I-4 " }).click();
            await list.locator("li.item").filter({ hasText: "I-5 " }).click();
            await page.getByLabel("Move items to bag").selectOption("bag-2");
            await page.getByRole("button", { name: "Move items" }).click();
            await page.getByText("Moved 2 items to Bag 2: Ceramic caps").waitFor();
            await list.locator("li.item.unknown").filter({ hasText: "I-4 hello world (in Bag 2: Ceramic caps)" }).waitFor();
            await list.locator("li.item.nocode").filter({ hasText: "I-5 (photo, no code) (in Bag 2: Ceramic caps)" }).waitFor();
            await page.getByRole("button", { name: "Done editing" }).click();
            expect(await unknown.textContent()).toContain("I-4 hello worldBag 2: Ceramic caps");
            expect(await photos.textContent()).toContain("I-5 (photo, no code)Bag 2: Ceramic caps");
            await page.locator(".tree summary").filter({ hasText: "Box 1: Passives" }).click();
            await page.locator(".tree summary").filter({ hasText: "Bag 2: Ceramic caps" }).click();
            await page.locator(".tree").getByText("I-3 Single AND gate").waitFor();
            const bag2 = page.locator(".tree").locator("xpath=.//details[summary[contains(., 'Bag 2: Ceramic caps')]]");
            expect(await bag2.locator("xpath=./summary").textContent()).toContain("3 items, 2 to identify");
            await shot(page, "browse-unidentified");

            // A name identifies the photo: it leaves its heading and files into its bag like any item.
            await photos.getByText("I-5 (photo, no code)").click();
            await page.locator(".modal").getByText("Photo of a bag with no code").waitFor();
            await page.locator(".modal").getByLabel("Name / description").fill("Mystery caps");
            await page.locator(".modal").getByRole("button", { name: "Save" }).click();
            await photos.waitFor({ state: "detached" });
            await bag2.getByText("I-5 Mystery caps").waitFor();
            expect(await bag2.locator("xpath=./summary").textContent()).toContain("4 items, 1 to identify");

            const download = page.waitForEvent("download");
            await page.getByRole("button", { name: "Export CSV" }).click();
            const csv = await Bun.file((await (await download).path())!).text();
            const lines = csv.trim().split("\r\n");
            expect(lines[0]).toStartWith("id,type,name,mpn,vendor_pn,bag_qty,count,");
            expect(lines).toHaveLength(6);
            expect(csv).toContain("I-4,,,,,,,,,,unknown,Bag 2: Ceramic caps,Box 1: Passives,");
            expect(csv).toContain("I-5,,Mystery caps,,,,,,,,manual,Bag 2: Ceramic caps,Box 1: Passives,");
        } finally {
            await browser.close();
        }
        expect(errors).toEqual([]);
    }, 60000);

    test("reading a label's printed text from a photo", async () => {
        const errors: string[] = [];
        const { browser, page } = await launch(await clip("qrsort:box:1", "QRCode"), errors);
        try {
            await loadSample(page, site.url);
            await page.getByRole("button", { name: "Inventory" }).click();
            const png = await page.evaluate(() => {
                const c = document.createElement("canvas");
                c.width = 1400;
                c.height = 320;
                const ctx = c.getContext("2d")!;
                ctx.fillStyle = "#fff";
                ctx.fillRect(0, 0, c.width, c.height);
                ctx.fillStyle = "#000";
                ctx.font = "40px sans-serif";
                ["DIGI-KEY PART NO.: 296-8286-1-ND", "MANUFACTURER PART NO.: SN74LVC1G08DBVR", "QUANTITY: 25"]
                    .forEach((t, i) => ctx.fillText(t, 40, 80 + i * 90));
                return c.toDataURL("image/png").split(",")[1];
            });
            const file = join(work, "label-text.png");
            await Bun.write(file, Buffer.from(png, "base64"));
            await page.getByLabel("Read text").check();
            await page.locator('input[type="file"][accept="image/*"]').setInputFiles(file);
            const sign = page.locator(".camera .flash.ok");
            await page.getByText(/Saved I-4 SN74LVC1G08DBVR x25/).first().waitFor({ timeout: 45000 });
            expect(await sign.count()).toBe(0); // the camera is off, so the sign is not drawn
            await page.getByRole("button", { name: "Browse" }).click();
            await page.locator(".tree").getByText("Box 1: Passives").click();
            await page.locator(".tree").getByText("Bag 1: 0805 resistors").click();
            await page.locator(".tree").getByText("I-4 SN74LVC1G08DBVR").click();
            const modal = page.locator(".modal");
            expect(await modal.locator("input.mono").first().inputValue()).toBe("SN74LVC1G08DBVR");
            expect(await modal.locator("textarea").inputValue()).toMatch(/^Read from the label text \(DIGIKEY\), \d+% confidence$/);
        } finally {
            await browser.close();
        }
        expect(errors).toEqual([]);
    }, 90000);

    test("a chosen photo with nothing to read is offered as a photo with no code", async () => {
        const errors: string[] = [];
        const { browser, page } = await launch(await clip("qrsort:box:1", "QRCode"), errors);
        try {
            await loadSample(page, site.url);
            await page.getByRole("button", { name: "Inventory" }).click();
            const png = await page.evaluate(() => {
                const c = document.createElement("canvas");
                c.width = 640;
                c.height = 480;
                const ctx = c.getContext("2d")!;
                ctx.fillStyle = "#cfd8dc";
                ctx.fillRect(0, 0, c.width, c.height);
                ctx.fillStyle = "#eceff1";
                ctx.fillRect(160, 120, 320, 240); // a plain bag, nothing printed on it
                return c.toDataURL("image/png").split(",")[1];
            });
            const file = join(work, "plain-bag.png");
            await Bun.write(file, Buffer.from(png, "base64"));
            await page.locator('input[type="file"][accept="image/*"]').setInputFiles(file);
            const draft = page.locator(".panel.nocode").filter({ hasText: "Photo, no code" });
            await draft.locator("img.photo").waitFor();
            await draft.getByRole("button", { name: "Save" }).click();
            await page.getByText("1 photo with no code waits to be identified.").waitFor();
            await page.getByText("No code: photo I-4 kept apart").first().waitFor();
            await page.getByRole("button", { name: "Browse" }).click();
            const photos = page.locator(".tree details.nocode");
            expect(await photos.textContent()).toContain("I-4 (photo, no code)not in a bag");
            await photos.locator("img.thumb").waitFor();
        } finally {
            await browser.close();
        }
        expect(errors).toEqual([]);
    }, 60000);
});
