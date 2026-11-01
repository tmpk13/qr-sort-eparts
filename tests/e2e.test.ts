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
            await tree.locator("summary").filter({ hasText: "Bag 1: 0805 resistors" }).waitFor();
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

            // The same label again while filling another bag of the same box: counted once, and the sign says where.
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
            expect(await page.locator(".tree li.focused").first().textContent()).toContain("I-3");
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
            expect(await sign.textContent()).toBe("Saved I-4 100nF GRM188R71H104KA93D");
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
            await page.locator(".tree summary").filter({ hasText: "Bag 2: Ceramic caps" }).click();
            await page.locator(".tree").getByText("I-4 100nF GRM188R71H104KA93D").waitFor();
            expect(await page.locator(".tree").textContent()).not.toContain("Batches");
        } finally {
            await browser.close();
        }
        expect(errors).toEqual([]);
    }, 60000);

    test("unidentified codes and photos are filed where scanned, flagged; retake; edit mode; CSV export", async () => {
        const errors: string[] = [];
        const { browser, page } = await launch(await clip("hello world", "QRCode"), errors);
        try {
            await loadSample(page, site.url);
            await page.getByRole("button", { name: "Inventory" }).click();
            await page.getByRole("button", { name: "Start camera" }).first().click();
            const unknownSign = page.locator(".camera .flash.unknown");
            await unknownSign.waitFor({ timeout: 20000 });
            expect(await unknownSign.textContent()).toBe("Unidentified: I-4 in Bag 1: 0805 resistors");
            await page.getByText("1 unidentified code waits to be identified.").waitFor();
            await shot(page, "unidentified");
            // Keep the code in view from being taken again while the rest is done by hand.
            await page.getByLabel("Auto scan").uncheck();

            await page.getByRole("button", { name: "Retake last (I-4)" }).click();
            await page.getByText("New photo for I-4 hello world").waitFor();

            // Added by hand with a photo and nothing else: an unidentified photo in the bag being filled.
            await page.getByRole("button", { name: "Add by hand" }).click();
            const draft = page.locator(".panel.draft");
            await draft.getByRole("button", { name: "Take photo" }).click();
            await draft.locator("img.photo").waitFor();
            expect(await draft.textContent()).toContain("goes into Bag 1: 0805 resistors flagged unidentified");
            await draft.getByRole("button", { name: "Save" }).click();
            const photoSign = page.locator(".camera .flash.nocode");
            await photoSign.waitFor();
            expect(await photoSign.textContent()).toBe("No code: I-5 in Bag 1: 0805 resistors, unidentified");
            await page.getByText("1 unidentified code and 1 photo with no code wait to be identified.").waitFor();
            await shot(page, "photo-no-code");
            await page.getByRole("button", { name: "Stop camera" }).click();

            await page.getByRole("button", { name: "Browse" }).click();
            const tree = page.locator(".tree");
            const unknown = tree.locator("details.unknown");
            const photos = tree.locator("details.nocode");
            expect(await unknown.textContent()).toContain("I-4 hello world unidentifiedBag 1: 0805 resistors");
            expect(await photos.textContent()).toContain("I-5 (photo, no code) unidentifiedBag 1: 0805 resistors");
            await photos.locator("img.thumb").waitFor();
            // They are in the bag they were scanned into, marked.
            await tree.locator("summary").filter({ hasText: "Box 1: Passives" }).click();
            const bag = (name: string) => tree.locator(`xpath=.//details[summary[contains(., '${name}')]]`);
            await bag("Bag 1: 0805 resistors").locator("summary").first().click();
            expect(await bag("Bag 1: 0805 resistors").locator("xpath=./summary").textContent())
                .toContain("4 items, 2 unidentified");
            await bag("Bag 1: 0805 resistors").locator("li.unknown").filter({ hasText: "I-4 hello world" }).waitFor();
            await bag("Bag 1: 0805 resistors").locator("li.nocode").filter({ hasText: "I-5 (photo, no code)" }).waitFor();
            await shot(page, "browse-unidentified");

            // Edit mode moves them with the rest; the flag stays.
            await page.getByRole("button", { name: "Edit mode" }).click();
            const list = page.locator(".edit-list");
            await list.locator("li.item").filter({ hasText: "I-1 " }).click();
            await list.locator("li.item").filter({ hasText: "I-3 " }).click({ modifiers: ["Shift"] });
            expect(await list.locator("li.selected").count()).toBe(5);
            await shot(page, "edit-mode");
            await page.getByLabel("Move items to bag").selectOption("bag-2");
            await page.getByRole("button", { name: "Move items" }).click();
            await page.getByText("Moved 5 items to Bag 2: Ceramic caps").waitFor();
            await list.locator("li.item.unknown").filter({ hasText: "I-4 hello world (unidentified)" }).waitFor();
            await list.locator("li.item.nocode").filter({ hasText: "I-5 (photo, no code) (unidentified)" }).waitFor();
            await page.getByRole("button", { name: "Done editing" }).click();
            expect(await unknown.textContent()).toContain("I-4 hello world unidentifiedBag 2: Ceramic caps");
            await tree.locator("summary").filter({ hasText: "Box 1: Passives" }).click();
            await bag("Bag 2: Ceramic caps").locator("xpath=./summary").click();
            await tree.getByText("I-3 Single AND gate").waitFor();
            expect(await bag("Bag 2: Ceramic caps").locator("xpath=./summary").textContent())
                .toContain("5 items, 2 unidentified");

            // A name identifies the photo: the flag goes, it stays in its bag.
            await photos.getByText("I-5 (photo, no code)").click();
            await page.locator(".modal").getByText("Photo of a bag with no code").waitFor();
            await page.locator(".modal").getByLabel("Name / description").fill("Mystery caps");
            await page.locator(".modal").getByRole("button", { name: "Save" }).click();
            await photos.waitFor({ state: "detached" });
            await bag("Bag 2: Ceramic caps").getByText("I-5 Mystery caps").waitFor();
            expect(await bag("Bag 2: Ceramic caps").locator("xpath=./summary").textContent())
                .toContain("5 items, 1 unidentified");

            const download = page.waitForEvent("download");
            await page.getByRole("button", { name: "Export CSV" }).click();
            const csv = await Bun.file((await (await download).path())!).text();
            const lines = csv.trim().split("\r\n");
            expect(lines[0]).toStartWith("id,type,value,name,mpn,vendor_pn,bag_qty,count,");
            expect(lines).toHaveLength(6);
            expect(csv).toContain("I-1,resistor,10k,,RC0805FR-0710KL,");
            expect(csv).toContain("I-4,,,,,,,,,,,unknown,unidentified,Bag 2: Ceramic caps,Box 1: Passives,");
            expect(csv).toContain("I-5,,,Mystery caps,,,,,,,,manual,,Bag 2: Ceramic caps,Box 1: Passives,");
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
            await page.getByLabel("Scan a photo").setInputFiles(file);
            const sign = page.locator(".camera .flash.ok");
            await page.getByText(/Saved I-4 SN74LVC1G08DBVR x25/).first().waitFor({ timeout: 45000 });
            expect(await sign.count()).toBe(0); // the camera is off, so the sign is not drawn
            await page.getByRole("button", { name: "Browse" }).click();
            await page.locator(".tree").getByText("Box 1: Passives").click();
            await page.locator(".tree summary").filter({ hasText: "Bag 1: 0805 resistors" }).click();
            await page.locator(".tree").getByText("I-4 SN74LVC1G08DBVR").click();
            const modal = page.locator(".modal");
            expect(await modal.locator("input.mono").first().inputValue()).toBe("SN74LVC1G08DBVR");
            expect(await modal.locator("textarea").inputValue()).toMatch(/^Read from the label text \(DIGIKEY\), \d+% confidence$/);
        } finally {
            await browser.close();
        }
        expect(errors).toEqual([]);
    }, 90000);

    test("by hand: nothing to save without a photo or a name; a photo where nothing reads opens the form", async () => {
        const errors: string[] = [];
        const { browser, page } = await launch(await clip("qrsort:box:1", "QRCode"), errors);
        try {
            await loadSample(page, site.url);
            await page.getByRole("button", { name: "Inventory" }).click();
            await page.getByRole("button", { name: "Add by hand" }).click();
            const draft = page.locator(".panel.draft");
            await draft.getByRole("button", { name: "Save" }).click();
            await page.getByText("Take a photo, or fill in a part number or a name").waitFor();
            await draft.getByRole("button", { name: "Discard" }).click();

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
            await page.getByLabel("Scan a photo").setInputFiles(file);
            await draft.getByText("Add by hand").waitFor();
            await draft.locator("img.photo").waitFor();
            expect(await draft.getAttribute("class")).toContain("nocode");
            await draft.getByRole("button", { name: "Save" }).click();
            await page.getByText("1 photo with no code waits to be identified.").waitFor();
            await page.getByText("No code: I-4 in Bag 1: 0805 resistors, unidentified").first().waitFor();
            await page.getByRole("button", { name: "Browse" }).click();
            const photos = page.locator(".tree details.nocode");
            expect(await photos.textContent()).toContain("I-4 (photo, no code) unidentifiedBag 1: 0805 resistors");
            await photos.locator("img.thumb").waitFor();
        } finally {
            await browser.close();
        }
        expect(errors).toEqual([]);
    }, 60000);

    test("values in the lists, sorting by type in a bag and in a whole box", async () => {
        const errors: string[] = [];
        const { browser, page } = await launch(await clip("qrsort:box:1", "QRCode"), errors);
        try {
            await loadSample(page, site.url);
            await page.getByRole("button", { name: "Browse" }).click();
            const tree = page.locator(".tree");
            await tree.locator("summary").filter({ hasText: "Box 1: Passives" }).click();
            const bag1 = tree.locator("xpath=.//details[summary[contains(., 'Bag 1: 0805 resistors')]]");
            await bag1.locator("xpath=./summary").click();
            const firstTitle = () => bag1.locator("li .title").first().textContent();
            await bag1.getByText("I-1 10k RC0805FR-0710KL").waitFor();
            expect(await firstTitle()).toBe("I-1 10k RC0805FR-0710KL");
            await page.getByLabel("Sort items").selectOption("type");
            await bag1.locator("li .title").first().filter({ hasText: "I-2 1k" }).waitFor();
            expect(await bag1.locator("li .title").allTextContents()).toEqual(["I-2 1k RC0805FR-071KL", "I-1 10k RC0805FR-0710KL"]);
            // The whole box in one list: drawn once opened, in the same order, each with its bag.
            const parts = tree.locator("details.box-parts").first();
            expect(await parts.locator("li").count()).toBe(0);
            await parts.locator("summary").click();
            await parts.locator("li").first().waitFor();
            expect(await parts.locator("li .title").allTextContents()).toEqual(["I-2 1k RC0805FR-071KL", "I-1 10k RC0805FR-0710KL"]);
            expect(await parts.locator("li").first().textContent()).toContain("Bag 1: 0805 resistors");
            await shot(page, "sorted-by-type");
            await page.getByRole("button", { name: "Inventory" }).click();
            await page.locator(".list").last().getByText("I-1 10k RC0805FR-0710KL").waitFor();
        } finally {
            await browser.close();
        }
        expect(errors).toEqual([]);
    }, 60000);

    test("marker color: picked in a picture, isolated, and a count written in it read on a scan", async () => {
        const errors: string[] = [];
        const { browser, page } = await launch(await clip("qrsort:box:1", "QRCode"), errors);
        try {
            await loadSample(page, site.url);
            // A bag: pink plastic, a printed label, and "37" written on it in red.
            const bagPng = await page.evaluate(() => {
                const c = document.createElement("canvas");
                c.width = 800;
                c.height = 500;
                const ctx = c.getContext("2d")!;
                ctx.fillStyle = "#f8bccb";
                ctx.fillRect(0, 0, c.width, c.height);
                ctx.fillStyle = "#fff";
                ctx.fillRect(40, 40, 440, 200);
                ctx.fillStyle = "#111";
                ctx.font = "28px sans-serif";
                ["DIGI-KEY PART NO.: 296-8286-1-ND", "QTY: 100"].forEach((t, i) => ctx.fillText(t, 60, 100 + i * 50));
                ctx.fillStyle = "#c81e1e";
                ctx.font = "bold 150px sans-serif";
                ctx.fillText("37", 520, 420);
                return c.toDataURL("image/png").split(",")[1];
            });
            const bagFile = join(work, "marker-bag.png");
            await Bun.write(bagFile, Buffer.from(bagPng, "base64"));
            await page.getByRole("button", { name: "Settings" }).click();
            const panel = page.locator(".panel.marker");
            await panel.getByLabel("Choose a picture").setInputFiles(bagFile);
            const pick = panel.locator("canvas.marker-pick");
            await pick.waitFor();
            // A pixel well inside the red writing: red all around it.
            const spot = await pick.evaluate((c: HTMLCanvasElement) => {
                const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
                const red = (x: number, y: number) => {
                    const i = (y * c.width + x) * 4;
                    return d[i] > 170 && d[i + 1] < 70 && d[i + 2] < 70;
                };
                for (let y = 4; y < c.height - 4; y++) {
                    for (let x = 4; x < c.width - 4; x++) {
                        if (red(x, y) && red(x - 4, y) && red(x + 4, y) && red(x, y - 4) && red(x, y + 4)) {
                            return { x: (x + 0.5) / c.width, y: (y + 0.5) / c.height };
                        }
                    }
                }
                return null;
            });
            expect(spot).not.toBeNull();
            const box = (await pick.boundingBox())!;
            await pick.click({ position: { x: spot!.x * box.width, y: spot!.y * box.height } });
            await panel.locator(".swatch").waitFor();
            // Only the writing is left in the second picture: no pink bag, no black print.
            const preview = panel.locator("canvas.marker-preview");
            await page.waitForTimeout(300);
            const kept = await preview.evaluate((c: HTMLCanvasElement) => {
                const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
                let ink = 0;
                let pink = 0;
                let dark = 0;
                for (let i = 0; i < d.length; i += 4) {
                    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
                    ink += Number(r > 150 && g < 100 && b < 100);
                    pink += Number(r > 230 && g > 170 && g < 240 && b > 180 && b < 245);
                    dark += Number(r < 80 && g < 80 && b < 80);
                }
                return { ink, pink, dark };
            });
            expect(kept.ink).toBeGreaterThan(1000);
            expect(kept.pink).toBeLessThan(50);
            expect(kept.dark).toBeLessThan(50);
            await shot(page, "marker");
            await panel.getByRole("button", { name: "Read count" }).click();
            const result = panel.locator(".badge[role=status]");
            await result.waitFor({ timeout: 45000 });
            expect(await result.textContent()).toMatch(/^Read 37 at \d+% confidence$/);

            // A scanned bag with 52 written next to its code: the count comes from the marker.
            await panel.getByLabel("Read the count written in this color when a bag is saved").check();
            // DK_OLD is a rectangular symbol, 66 by 26 modules: 396 by 156 pixels at scale 6.
            const code = await writeBarcode(DK_OLD, { format: "DataMatrix", scale: 6 });
            const codeB64 = Buffer.from(await code.image!.arrayBuffer()).toString("base64");
            const scanPng = await page.evaluate(async (b64: string) => {
                const img = new Image();
                img.src = `data:image/png;base64,${b64}`;
                await img.decode();
                const c = document.createElement("canvas");
                c.width = 900;
                c.height = 500;
                const ctx = c.getContext("2d")!;
                ctx.fillStyle = "#fff";
                ctx.fillRect(0, 0, c.width, c.height);
                ctx.drawImage(img, 40, 40);
                ctx.fillStyle = "#c81e1e";
                ctx.font = "bold 150px sans-serif";
                ctx.fillText("52", 560, 400);
                return c.toDataURL("image/png").split(",")[1];
            }, codeB64);
            const scanFile = join(work, "marker-scan.png");
            await Bun.write(scanFile, Buffer.from(scanPng, "base64"));
            await page.getByRole("button", { name: "Inventory" }).click();
            await page.getByLabel("Scan a photo").setInputFiles(scanFile);
            await page.getByText("Saved I-4 SN74LVC1G08DBVR x10").first().waitFor({ timeout: 20000 });
            const counted = page.getByText(/^(Count \d+ read from the marker for I-4|Marker count .*|Reading the marker failed.*)$/);
            await counted.first().waitFor({ timeout: 45000 });
            expect(await counted.first().textContent()).toBe("Count 52 read from the marker for I-4");
            const row = page.locator(".list").last().locator("li").filter({ hasText: "I-4" });
            await row.getByText("x52/10").waitFor();
        } finally {
            await browser.close();
        }
        expect(errors).toEqual([]);
    }, 120000);

    test("importing a Drive folder and a CSV file; importing the folder again adds nothing", async () => {
        const errors: string[] = [];
        const { browser, page } = await launch(await clip("qrsort:box:1", "QRCode"), errors);
        try {
            // The Drive script, answering from another origin the way Apps Script does.
            const asked: string[] = [];
            await page.route("https://script.google.com/**", (route) => {
                asked.push(route.request().url());
                return route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" },
                    body: JSON.stringify({ ok: true, folder: "F1", errors: [], ignored: ["notes.docx"], tables: [
                        { name: "Order 1.csv", kind: "csv", csv: "Index,Quantity,Part Number,Manufacturer Part Number,"
                            + "Description\r\n1,100,311-10KARCT-ND,RC0805FR-0710KL,RES 10K OHM 1% 1/8W 0805\r\n" },
                        { name: "Stock", kind: "sheet", rows: [["MPN", "Bag", "Box", "Shelf"],
                            ["GRM188R71H104KA93D", "Caps", "Box 1: Passives", "Left wall"]] },
                    ] }) });
            });
            await page.goto(`${site.url}/#settings`);
            const panel = page.locator(".panel").filter({ has: page.getByRole("heading", { name: "Import" }) });
            await page.getByLabel("Drive script URL").fill("https://script.google.com/macros/s/ID/exec");
            await page.getByLabel("Token").fill("s3cret");
            await page.getByRole("button", { name: "Import from Drive" }).click();
            await panel.getByText("2 items added, 0 imported before, 0 rows skipped; made 1 shelf, 1 box, 2 bags")
                .waitFor();
            expect(asked).toEqual(["https://script.google.com/macros/s/ID/exec?token=s3cret"]);
            await panel.getByText("notes.docx: not a CSV file or Google Sheet").waitFor();
            await shot(page, "import");
            await page.getByRole("button", { name: "Import from Drive" }).click();
            await panel.getByText("0 items added, 2 imported before, 0 rows skipped").waitFor();
            await page.getByLabel("Import CSV file").setInputFiles({ name: "extra.csv", mimeType: "text/csv",
                buffer: Buffer.from("mpn,bag\nSN74LVC1G08DBVR,Caps\n") });
            await panel.getByText("1 item added, 0 imported before, 0 rows skipped").waitFor();

            await page.getByRole("button", { name: "Browse" }).click();
            const tree = page.locator(".tree");
            await tree.locator("summary").filter({ hasText: "Box 1: Passives" }).click();
            const caps = tree.locator("xpath=.//details[summary[contains(., 'Bag 2: Caps')]]");
            await caps.locator("xpath=./summary").click();
            await caps.getByText("100nF GRM188R71H104KA93D").waitFor();
            await caps.getByText("SN74LVC1G08DBVR").waitFor();
            const order = tree.locator("xpath=.//details[summary[contains(., 'Bag 1: Order 1.csv')]]");
            await order.locator("xpath=./summary").click();
            await order.getByText("10k RES 10K OHM 1% 1/8W 0805").waitFor();
        } finally {
            await browser.close();
        }
        expect(errors).toEqual([]);
    }, 60000);
});
