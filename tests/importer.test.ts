// Parts list import: CSV parsing, heading matching, places by name or number, keys that keep a
// second import from adding the same rows again, and the Drive script's answer.
import "fake-indexeddb/auto";
import { describe, expect, test } from "bun:test";
import { toCsv } from "../src/csv.ts";
import { Db } from "../src/db.ts";
import { fetchDrive, findPlace, importTables, mapHeadings, parseCsv, placeRef, tableRows, type Table }
    from "../src/importer.ts";
import { display, UNIDENTIFIED } from "../src/model.ts";
import { blankItem, Store } from "../src/store.ts";
import { DK_NEW } from "./fixtures.ts";

async function fresh(): Promise<Store> {
    const s = new Store();
    await s.init(await Db.open(`test-${crypto.randomUUID()}`));
    return s;
}

const csv = (lines: string[]) => lines.join("\r\n") + "\r\n";

describe("parseCsv", () => {
    test("quotes hold commas, doubled quotes and line breaks; BOM and trailing newline dropped", () => {
        const text = String.fromCharCode(0xfeff) + 'a,b,c\r\n"x, y","say ""hi""","two\nlines"\r\n,,\r\n';
        expect(parseCsv(text)).toEqual([["a", "b", "c"], ["x, y", 'say "hi"', "two\nlines"], ["", "", ""]]);
    });

    test("a quote inside an unquoted cell is just a character", () => {
        expect(parseCsv('LCD 5" screen,2\nnext,3')).toEqual([['LCD 5" screen', "2"], ["next", "3"]]);
    });

    test("semicolon and tab delimiters are recognized from the first lines", () => {
        expect(parseCsv("mpn;qty\nRC0805;1,5\n")).toEqual([["mpn", "qty"], ["RC0805", "1,5"]]);
        expect(parseCsv("mpn\tqty\nRC0805\t10")).toEqual([["mpn", "qty"], ["RC0805", "10"]]);
        expect(parseCsv("a\rb")).toEqual([["a"], ["b"]]);
    });
});

describe("headings", () => {
    test("DigiKey order export: the plain part number is DigiKey's once the manufacturer's is named", () => {
        const c = mapHeadings(["Index", "Quantity", "Part Number", "Manufacturer Part Number", "Description",
            "Customer Reference", "Unit Price"]);
        expect(c.at).toEqual({ qty: 1, vendorPn: 2, mpn: 3, name: 4 });
        expect(c.extra).toEqual([[5, "Customer Reference"], [6, "Unit Price"]]);
    });

    test("Mouser and LCSC exports name their distributor", () => {
        const m = mapHeadings(["Mouser #", "Mfr. #", "Manufacturer", "Description", "Order Qty."]);
        expect(m.at).toEqual({ vendorPn: 0, mpn: 1, name: 3, qty: 4 });
        expect(m.vendor).toBe("mouser");
        const l = mapHeadings(["LCSC Part Number", "Manufacture Part Number", "Package", "Order Qty."]);
        expect(l.at).toEqual({ vendorPn: 0, mpn: 1, qty: 3 });
        expect(l.vendor).toBe("lcsc");
    });

    test("a lone part number heading is the manufacturer's", () => {
        expect(mapHeadings(["Part #", "Qty"]).at).toEqual({ mpn: 0, qty: 1 });
    });
});

describe("tableRows", () => {
    const table = (rows: string[][]): Table => ({ name: "Parts.csv", rows });

    test("heading below a title; blank, repeated heading and nameless rows; numbers, types and values", () => {
        const r = tableRows(table([
            ["Lab parts", "", ""],
            ["MPN", "Qty", "Type", "Footprint", "Notes"],
            ["RC0805FR-0710KL", "1,000", "Resistor", "0805", "reel"],
            ["", "", "", "", ""],
            ["MPN", "Qty", "Type", "Footprint", "Notes"],
            ["GRM188R71H104KA93D", "50 pcs", "", "", ""],
            ["'+5V-REG", "", "", "", ""],
            ["", "1050", "", "", "total"],
        ]), {}, 1000);
        expect(r.error).toBe("");
        expect(r.skipped).toBe(1);
        expect(r.rows.map((x) => x.item)).toMatchObject([
            { mpn: "RC0805FR-0710KL", qty: 1000, count: 1000, type: "resistor", value: "10k",
                notes: "reel; Footprint: 0805", source: "import", created: 1000 },
            { mpn: "GRM188R71H104KA93D", qty: 50, type: "capacitor", value: "100nF", notes: "" },
            { mpn: "+5V-REG", qty: null },
        ]);
    });

    test("learned types win over the guess; a type typed in is kept as written", () => {
        const r = tableRows(table([["mpn", "type"], ["RC0805FR-0710KL", ""], ["XYZ1", "Sensor board"]]),
            { RC0: "other" });
        expect(r.rows.map((x) => x.item.type)).toEqual(["other", "Sensor board"]);
    });

    test("a table with no heading naming a part says so", () => {
        expect(tableRows(table([["Qty", "Price"], ["1", "2"]])).error).toMatch(/no heading row/);
    });

    test("keys follow what identifies the bag, not its count, place or notes", () => {
        const a = tableRows(table([["mpn", "qty", "bag", "notes"], ["X1", "10", "Bag 1", "a"]])).rows[0];
        const b = tableRows(table([["notes", "bag", "qty", "mpn"], ["b", "Bag 2", "7", "x1"]])).rows[0];
        const c = tableRows(table([["mpn", "lot"], ["X1", "L2"]])).rows[0];
        expect(a.key).toBe(b.key);
        expect(c.key).not.toBe(a.key);
    });
});

describe("places", () => {
    test("number, number and name, or a name", () => {
        expect(placeRef("bag", "Bag 3: Resistors")).toEqual({ n: 3, name: "Resistors" });
        expect(placeRef("bag", " bag 3 ")).toEqual({ n: 3, name: "" });
        expect(placeRef("box", "Bag 3")).toEqual({ n: null, name: "Bag 3" });
        expect(placeRef("shelf", "Left wall")).toEqual({ n: null, name: "Left wall" });
    });

    test("the number wins unless both names differ; names look in the parent given, or anywhere", () => {
        const bags = [{ id: "bag-1", name: "Caps", boxId: "box-1" }, { id: "bag-2", name: "", boxId: null },
            { id: "bag-3", name: "Resistors", boxId: "box-2" }];
        const find = (text: string, parent?: string | null) =>
            findPlace("bag", placeRef("bag", text), bags, (b) => b.boxId, parent)?.id;
        expect(find("Bag 1")).toBe("bag-1");
        expect(find("Bag 1: caps")).toBe("bag-1");
        expect(find("Bag 2: Anything")).toBe("bag-2");
        expect(find("Bag 1: Resistors")).toBe("bag-3");
        expect(find("Resistors", "box-2")).toBe("bag-3");
        expect(find("Resistors", "box-1")).toBeUndefined();
        expect(find("Resistors", null)).toBeUndefined();
        expect(find("Anything: else", null)).toBeUndefined();
        expect(find("Bag 9")).toBeUndefined();
    });
});

describe("importing into the store", () => {
    test("a qr-sort CSV export comes back with its shelves, boxes, bags and numbers", async () => {
        const a = await fresh();
        const shelf = await a.createShelf("Left wall");
        await a.createBox("Spare", shelf.id);
        const box = await a.createBox("Passives", shelf.id);
        const bag = await a.createBag("0805 resistors", box.id);
        const loose = await a.createBag("Loose", null);
        const batch = await a.createBatch();
        await a.saveItem({ ...blankItem(bag.id), mpn: "RC0805FR-0710KL", vendorPn: "311-10KARCT-ND", qty: 100,
            count: 40, type: "resistor", value: "10k", dateCode: "2310", source: "digikey", raw: DK_NEW,
            notes: "half used", created: 1_700_000_000_123 });
        await a.saveItem({ ...blankItem(loose.id), raw: "HELLO", created: 1_700_000_000_456 });
        await a.saveItem({ ...blankItem(null, batch.id), mpn: "SN74LVC1G08DBVR", qty: 10 });
        await a.saveItem({ ...blankItem(bag.id), hasPhoto: true }, new Blob(["photo"]));

        const b = await fresh();
        const r = await importTables(b, [{ name: "export.csv", rows: parseCsv(toCsv(a.data)) }], "file:export.csv");
        expect(r.tables).toEqual([{ name: "export.csv", added: 3, already: 0, skipped: 1, error: "" }]);
        expect(r.made).toEqual({ shelves: 1, boxes: 1, bags: 3 });

        expect(b.data.shelves.map(display)).toEqual(["Shelf 1: Left wall"]);
        expect(b.boxesOn("shelf-1").map((x) => `${display(x)}@${x.position}`)).toEqual(["Box 2: Passives@1"]);
        expect(b.bagsIn("box-2").map(display)).toEqual(["Bag 1: 0805 resistors"]);
        expect(b.bagsIn(null).map(display).sort()).toEqual(["Bag 2: Loose", "Bag 3: export.csv"]);
        expect(b.itemsIn("bag-1")).toMatchObject([{ mpn: "RC0805FR-0710KL", vendorPn: "311-10KARCT-ND", qty: 100,
            count: 40, type: "resistor", value: "10k", dateCode: "2310", source: "digikey", notes: "half used",
            created: 1_700_000_000_123, seq: 1, flags: [] }]);
        expect(b.itemsIn("bag-2")).toMatchObject([{ raw: "HELLO", flags: [UNIDENTIFIED] }]);
        expect(b.itemsIn("bag-3")).toMatchObject([{ mpn: "SN74LVC1G08DBVR", qty: 10, batchId: null }]);
        // Numbers taken from the rows are not handed out again.
        expect((await b.createBox()).id).toBe("box-3");
        expect((await b.createBag()).id).toBe("bag-4");
    });

    test("importing again adds only new rows; a count changed or a row moved is not new", async () => {
        const s = await fresh();
        const sheet = (rows: string[]) => [{ name: "Parts", rows: parseCsv(csv(["MPN,Qty,Box", ...rows])) }];
        let r = await importTables(s, sheet(["X1,10,Passives", "X1,10,Passives", "Y2,5,"]), "drive:F");
        expect(r.tables[0]).toMatchObject({ added: 3, already: 0 });
        expect(r.made).toEqual({ shelves: 0, boxes: 1, bags: 2 });
        expect(s.bagsIn(null).map((x) => x.name)).toEqual(["Parts"]);
        expect(s.bagsIn(s.data.boxes[0].id).map((x) => x.name)).toEqual(["Parts"]);

        r = await importTables(s, sheet(["Y2,4,", "X1,10,Passives", "X1,10,Passives"]), "drive:F");
        expect(r.tables[0]).toMatchObject({ added: 0, already: 3 });

        r = await importTables(s, sheet(["X1,10,Passives", "Z3,1,Passives", "X1,10,Passives", "X1,2,", "Y2,5,"]),
            "drive:F");
        expect(r.tables[0]).toMatchObject({ added: 2, already: 3 });
        expect(s.data.items.length).toBe(5);
        expect(r.made).toEqual({ shelves: 0, boxes: 0, bags: 0 });

        // Another source keeps its own keys.
        r = await importTables(s, sheet(["X1,10,Passives"]), "file:Parts.csv");
        expect(r.tables[0]).toMatchObject({ added: 1, already: 0 });
    });

    test("rows go into existing places by number or name; a label read twice in one box counts once", async () => {
        const s = await fresh();
        const box = await s.createBox("Semis");
        const bag = await s.createBag("Logic", box.id);
        const r = await importTables(s, [{ name: "t", rows: [["MPN", "Bag", "Box", "Code"],
            ["A1", "Bag 1", "", ""], ["A2", "logic", "Box 1", ""], ["A3", "", "semis", "CODE9"],
            ["A4", "", "Semis", "CODE9"]] }], "x");
        expect(r.tables[0]).toMatchObject({ added: 3, already: 1 });
        expect(s.itemsIn(bag.id).map((i) => i.mpn)).toEqual(["A1", "A2"]);
        expect(s.bagsIn(box.id).map(display)).toEqual(["Bag 1: Logic", "Bag 2: t"]);
    });
});

describe("fetchDrive", () => {
    const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

    test("CSV text and sheet cells become tables; problems are listed", async () => {
        let asked = "";
        const get = (async (url: string) => {
            asked = url;
            return answer({ ok: true, folder: "F1", tables: [{ name: "a.csv", csv: "mpn\nX" },
                { name: "b / Sheet1", rows: [["mpn"], [12]] }], errors: [{ file: "c.csv", error: "boom" }],
                ignored: ["d.xlsx"] })();
        }) as typeof fetch;
        const r = await fetchDrive(" https://script.google.com/macros/s/ID/exec ", " t0k ", get);
        expect(asked).toBe("https://script.google.com/macros/s/ID/exec?token=t0k");
        expect(r).toEqual({ folder: "F1", tables: [{ name: "a.csv", rows: [["mpn"], ["X"]] },
            { name: "b / Sheet1", rows: [["mpn"], ["12"]] }],
            problems: ["c.csv: boom", "d.xlsx: not a CSV file or Google Sheet"] });
    });

    test("the script's own errors, HTML pages and network failures are reported", async () => {
        const fail = (get: unknown) => fetchDrive("https://x/exec", "t", get as typeof fetch);
        await expect(fail(answer({ ok: false, error: "wrong or missing token" }))).rejects
            .toThrow("Drive script: wrong or missing token");
        await expect(fail(async () => new Response("<html>", { status: 404 }))).rejects.toThrow(/404 without JSON/);
        await expect(fail(async () => {
            throw new TypeError("Failed to fetch");
        })).rejects.toThrow(/Failed to fetch.*deployed for anyone/);
        await expect(fetchDrive("not a url", "t")).rejects.toThrow(/not a URL/);
    });
});
