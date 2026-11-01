// The Drive script (drive/Code.gs) run against stand-ins for the Apps Script services: the token,
// paged folder listing, CSV files and sheets, shortcuts, subfolders, and its answer imported.
import "fake-indexeddb/auto";
import { describe, expect, test } from "bun:test";
import { Db } from "../src/db.ts";
import { fetchDrive, importTables } from "../src/importer.ts";
import { Store } from "../src/store.ts";

const SHEET = "application/vnd.google-apps.spreadsheet";
const FOLDER = "application/vnd.google-apps.folder";

interface FakeFile {
    id: string;
    name: string;
    mimeType: string;
    parent: string;
    csv?: string;
    sheets?: { name: string; hidden?: boolean; rows: string[][] }[];
    target?: string; // shortcut target id
    broken?: boolean;
}

const source = await Bun.file(new URL("../drive/Code.gs", import.meta.url)).text();

function load(files: FakeFile[], props: Record<string, string>) {
    const queries: Record<string, unknown>[] = [];
    const logs: string[] = [];
    const byId = (id: string) => {
        const f = files.find((x) => x.id === id);
        if (!f) {
            throw new Error(`no file ${id}`);
        }
        return f;
    };
    const Drive = {
        Files: {
            // Two entries a page, so paging is exercised.
            list(params: Record<string, unknown>) {
                queries.push(params);
                const parent = /^'(.*)' in parents and trashed = false$/.exec(String(params.q))![1];
                const all = files.filter((f) => f.parent === parent).map((f) => ({ id: f.id, name: f.name,
                    mimeType: f.target ? "application/vnd.google-apps.shortcut" : f.mimeType,
                    modifiedTime: "2026-10-30T12:00:00.000Z", webViewLink: `https://drive/${f.id}`,
                    ...(f.target ? { shortcutDetails: { targetId: f.target, targetMimeType: f.mimeType } } : {}) }));
                const start = Number(params.pageToken ?? 0);
                const next = start + 2 < all.length ? String(start + 2) : undefined;
                return { files: all.slice(start, start + 2), nextPageToken: next };
            },
        },
    };
    const DriveApp = {
        getFileById: (id: string) => ({ getBlob: () => ({ getDataAsString: () => {
            const f = byId(id);
            if (f.broken) {
                throw new Error("Access denied: DriveApp.");
            }
            return f.csv!;
        } }) }),
    };
    const SpreadsheetApp = {
        openById: (id: string) => ({ getSheets: () => byId(id).sheets!.map((s, i) => ({
            getName: () => s.name,
            isSheetHidden: () => !!s.hidden,
            getSheetId: () => i * 100,
            getDataRange: () => ({ getDisplayValues: () => s.rows }),
        })) }),
    };
    const ContentService = {
        MimeType: { JSON: "json" },
        createTextOutput: (text: string) => ({ text, mime: "", setMimeType(m: string) {
            this.mime = m;
            return this;
        } }),
    };
    const PropertiesService = { getScriptProperties: () => ({
        getProperty: (k: string) => props[k] ?? null,
        setProperty: (k: string, v: string) => {
            props[k] = v;
        },
    }) };
    const Utilities = { getUuid: () => crypto.randomUUID() };
    const Logger = { log: (s: string) => logs.push(s) };
    const script: { doGet(e: unknown): { text: string; mime: string }; makeToken(): string; checkFolder(): unknown }
        = new Function("Drive", "DriveApp", "SpreadsheetApp", "ContentService", "PropertiesService",
        "Utilities", "Logger", `${source}\nreturn { doGet, makeToken, checkFolder };`)(Drive, DriveApp,
        SpreadsheetApp, ContentService, PropertiesService, Utilities, Logger);
    const get = (params: Record<string, string>) => {
        const out = script.doGet({ parameter: params });
        expect(out.mime).toBe("json");
        return JSON.parse(out.text);
    };
    return { ...script, get, queries, logs, props };
}

const folder: FakeFile[] = [
    { id: "c1", name: "resistors.csv", mimeType: "text/csv", parent: "F", csv: "MPN,Qty\nRC0805FR-0710KL,100\n" },
    { id: "s1", name: "Stock", mimeType: SHEET, parent: "F", sheets: [
        { name: "Caps", rows: [["MPN", "Bag"], ["GRM188R71H104KA93D", "Bag 4: Caps"]] },
        { name: "Lookup", hidden: true, rows: [["x"]] },
        { name: "Logic", rows: [["MPN"], ["SN74LVC1G08DBVR"]] }] },
    { id: "x1", name: "old.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        parent: "F" },
    { id: "c2", name: "locked.csv", mimeType: "text/csv", parent: "F", broken: true },
    { id: "d1", name: "Archive", mimeType: FOLDER, parent: "F" },
    { id: "c3", name: "2025.CSV", mimeType: "text/plain", parent: "d1", csv: "MPN\nLM358\n" },
    { id: "s2", name: "Single", mimeType: SHEET, parent: "elsewhere", sheets: [{ name: "Sheet1", rows: [["MPN"], ["NE555"]] }] },
    { id: "k1", name: "Link to Single", mimeType: SHEET, parent: "F", target: "s2" },
];

describe("Drive script", () => {
    test("refuses without a token set, a wrong token, or no folder", () => {
        expect(load(folder, { FOLDER_ID: "F" }).get({ token: "x" })).toEqual({ ok: false,
            error: "TOKEN is not set; run makeToken in the script editor" });
        expect(load(folder, { FOLDER_ID: "F", TOKEN: "t" }).get({ token: "x" })).toEqual({ ok: false,
            error: "wrong or missing token" });
        expect(load(folder, { FOLDER_ID: "F", TOKEN: "t" }).get({})).toMatchObject({ ok: false });
        expect(load(folder, { TOKEN: "t" }).get({ token: "t" })).toEqual({ ok: false,
            error: "FOLDER_ID is not set in the script properties" });
    });

    test("reads CSV files and visible sheets by name, follows shortcuts, lists the rest", () => {
        const s = load(folder, { FOLDER_ID: "F", TOKEN: "t" });
        const r = s.get({ token: "t" });
        expect(r.ok).toBe(true);
        expect(r.folder).toBe("F");
        expect(r.tables.map((t: { name: string; kind: string; sheet: string }) => [t.name, t.kind, t.sheet])).toEqual([
            ["Link to Single", "sheet", "Sheet1"],
            ["resistors.csv", "csv", ""],
            ["Stock / Caps", "sheet", "Caps"],
            ["Stock / Logic", "sheet", "Logic"],
        ]);
        expect(r.tables[1]).toMatchObject({ file: "resistors.csv", fileId: "c1", csv: "MPN,Qty\nRC0805FR-0710KL,100\n",
            modified: "2026-10-30T12:00:00.000Z", url: "https://drive/c1" });
        expect(r.tables[0]).toMatchObject({ fileId: "s2", rows: [["MPN"], ["NE555"]] });
        expect(r.tables[3]).toMatchObject({ url: "https://drive/s1#gid=200", rows: [["MPN"], ["SN74LVC1G08DBVR"]] });
        expect(r.errors).toEqual([{ file: "locked.csv", fileId: "c2", error: "Access denied: DriveApp." }]);
        expect(r.ignored).toEqual(["old.xlsx"]);
        // Every page of the folder was asked for, across shared drives.
        expect(s.queries.map((q) => q.pageToken)).toEqual([undefined, "2", "4"]);
        expect(s.queries[0]).toMatchObject({ supportsAllDrives: true, includeItemsFromAllDrives: true,
            corpora: "allDrives" });
    });

    test("subfolders with RECURSIVE, named by their path", () => {
        const r = load(folder, { FOLDER_ID: "F", TOKEN: "t", RECURSIVE: "true" }).get({ token: "t" });
        expect(r.tables[0]).toMatchObject({ name: "Archive/2025.CSV", kind: "csv", csv: "MPN\nLM358\n" });
    });

    test("makeToken stores a token the web app then accepts; checkFolder logs the tables", () => {
        const s = load(folder, { FOLDER_ID: "F" });
        const token = s.makeToken();
        expect(token).toMatch(/^[0-9a-f]{32}$/);
        expect(s.props.TOKEN).toBe(token);
        expect(s.get({ token }).ok).toBe(true);
        s.checkFolder();
        expect(s.logs).toContain("resistors.csv: 2 lines");
        expect(s.logs).toContain("Stock / Caps: 2 rows");
        expect(s.logs).toContain("old.xlsx: not a CSV file or Google Sheet");
    });

    test("its answer, fetched and imported, fills the store", async () => {
        const s = load(folder, { FOLDER_ID: "F", TOKEN: "t" });
        const get = (async (url: string) => new Response(s.doGet({ parameter: Object.fromEntries(new URL(url)
            .searchParams) }).text)) as typeof fetch;
        const reply = await fetchDrive("https://script.google.com/macros/s/ID/exec", "t", get);
        expect(reply.problems).toEqual(["locked.csv: Access denied: DriveApp.", "old.xlsx: not a CSV file or Google Sheet"]);
        const store = new Store();
        await store.init(await Db.open(`test-${crypto.randomUUID()}`));
        const r = await importTables(store, reply.tables, `drive:${reply.folder}`);
        expect(r.tables.map((t) => t.added)).toEqual([1, 1, 1, 1]);
        expect(store.data.bags.map((b) => `${b.id} ${b.name}`).sort()).toEqual(["bag-1 Link to Single", "bag-2 resistors.csv",
            "bag-4 Caps", "bag-5 Stock / Logic"]);
        const item = store.data.items.find((i) => i.mpn === "RC0805FR-0710KL");
        expect(item).toMatchObject({ qty: 100, bagId: "bag-2", type: "resistor", value: "10k" });
        expect(item?.importKey).toStartWith("drive:F:");
        const again = await importTables(store, (await fetchDrive("https://x/exec", "t", get)).tables, "drive:F");
        expect(again.tables.map((t) => t.added)).toEqual([0, 0, 0, 0]);
    });
});
