// Parts lists into items: CSV files and Google Sheets, read from this computer or fetched from the
// Drive script, matched to item fields by their column headings and filed into bags, boxes and
// shelves by name or number.
import { KIND_TITLE, makeId, type Item, type Kind } from "./model.ts";
import { familyKey, guessType, TYPES } from "./parse.ts";
import type { Store } from "./store.ts";
import { valueFromPartNumber } from "./value.ts";

/** A grid of cells: one CSV file, or one sheet of a spreadsheet. */
export interface Table {
    name: string; // the file's name, with the sheet's when the spreadsheet has several
    rows: string[][];
}

/** One row of a table as an item, with its place as written. */
export interface ImportRow {
    table: string; // rows that name no bag go in a bag named after their table
    key: string; // the same row imported again has the same key
    item: Partial<Item>;
    bag: string; // "Bag 3: Resistors", "Bag 3", "Resistors" or ""
    box: string;
    shelf: string;
}

export interface Made {
    shelves: number;
    boxes: number;
    bags: number;
}

export interface TableReport {
    name: string;
    added: number;
    already: number; // imported before, or the same label in the same box
    skipped: number; // rows with cells but no part number, name or code (totals, remarks)
    error: string; // why nothing was read from it
}

export interface ImportReport {
    tables: TableReport[];
    made: Made;
}

/**
 * CSV as spreadsheets write it: a quoted cell may hold the delimiter, doubled quotes and line breaks.
 * The delimiter is a comma, or a semicolon or tab when the first lines hold more of those.
 */
export function parseCsv(text: string): string[][] {
    if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
    }
    const sep = delimiter(text);
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    let fresh = true; // nothing read into this cell yet: only here does a quote open one
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c !== '"') {
                cell += c;
            } else if (text[i + 1] === '"') {
                cell += '"';
                i++;
            } else {
                quoted = false;
            }
        } else if (c === '"' && fresh) {
            quoted = true;
            fresh = false;
        } else if (c === sep) {
            row.push(cell);
            cell = "";
            fresh = true;
        } else if (c === "\r" || c === "\n") {
            if (c === "\r" && text[i + 1] === "\n") {
                i++;
            }
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
            fresh = true;
        } else {
            cell += c;
            fresh = false;
        }
    }
    if (cell || row.length) {
        row.push(cell);
        rows.push(row);
    }
    return rows;
}

function delimiter(text: string): string {
    const head = text.split(/\r\n|\r|\n/, 5).join("\n");
    const count = (c: string) => head.split(c).length - 1;
    return [";", "\t"].reduce((best, c) => (count(c) > count(best) ? c : best), ",");
}

/** A cell as meant: trimmed, without the quote mark that stops spreadsheets running it as a formula. */
function clean(cell: unknown): string {
    const s = String(cell ?? "").trim();
    return /^'[=+@\t\r]/.test(s) ? s.slice(1).trim() : s;
}

type Column = "mpn" | "vendorPn" | "name" | "type" | "value" | "qty" | "count" | "dateCode" | "lot" | "country"
    | "source" | "flags" | "notes" | "code" | "created" | "bag" | "box" | "shelf";

/** A heading as compared: lower case letters and digits, "#" read as "no" ("Mfr. #" is "mfrno"). */
export function headingKey(h: string): string {
    return h.toLowerCase().replace(/#/g, "no").replace(/[^a-z0-9]/g, "");
}

// What each column is called in qr-sort's own CSV and in distributors' order and cart exports, best
// first. A plain "Part Number" is the manufacturer's unless a heading claims that, then the vendor's.
const HEADINGS: [Column, string[]][] = [
    ["mpn", ["mpn", "manufacturerpartnumber", "manufacturerpartno", "manufacturerpn", "manufacturepartnumber",
        "mfrpartnumber", "mfrpartno", "mfrpn", "mfrno", "mfgpartnumber", "mfgpartno", "mfgpn", "partnumber", "partno",
        "pn"]],
    ["vendorPn", ["vendorpn", "vendorpartnumber", "vendorpartno", "digikeypartnumber", "digikeypartno", "digikeypn",
        "dkpn", "mouserpartnumber", "mouserpartno", "mouserno", "mouserpn", "lcscpartnumber", "lcscpartno", "lcscpn",
        "lcsc", "supplierpartnumber", "supplierpn", "distributorpartnumber", "sku", "partnumber", "partno", "pn"]],
    ["name", ["name", "partname", "description", "desc", "partdescription", "productdescription"]],
    ["type", ["type", "parttype", "category"]],
    ["value", ["value", "val"]],
    ["qty", ["bagqty", "qty", "quantity", "orderqty", "orderquantity", "qtyordered", "quantityordered", "qtyshipped",
        "quantityshipped", "shippedqty"]],
    ["count", ["count", "onhand", "qtyonhand", "quantityonhand", "stock", "instock"]],
    ["dateCode", ["datecode", "dc"]],
    ["lot", ["lot", "lotcode", "lotno", "lotnumber"]],
    ["country", ["country", "countryoforigin", "coo"]],
    ["source", ["source"]],
    ["flags", ["flags", "flag", "tags"]],
    ["notes", ["notes", "note", "comments", "comment", "remarks"]],
    ["code", ["code", "barcode"]],
    ["created", ["created", "dateadded", "added"]],
    ["bag", ["bag"]],
    ["box", ["box", "bin"]],
    ["shelf", ["shelf", "rack"]],
];

// Columns left out of the notes too: qr-sort's item number, batch and box position mean nothing in
// another database (box order comes from row order), and line numbers mean nothing at all.
const IGNORED = new Set(["id", "batch", "position", "index", "no", "line", "lineno"]);

const IDENTITY: Column[] = ["mpn", "vendorPn", "name", "code"];

export interface Columns {
    at: Partial<Record<Column, number>>; // the cell of each column found
    extra: [number, string][]; // the other columns with a heading, kept in the notes as "Heading: value"
    vendor: string; // the distributor that the vendor part number's heading names, or ""
}

export function mapHeadings(row: string[]): Columns {
    const keys = row.map((h) => headingKey(clean(h)));
    const at: Partial<Record<Column, number>> = {};
    const used = new Set(keys.flatMap((k, i) => (IGNORED.has(k) ? [i] : [])));
    for (const [column, names] of HEADINGS) {
        let best = -1;
        let rank = names.length;
        keys.forEach((k, i) => {
            const r = names.indexOf(k);
            if (r >= 0 && r < rank && !used.has(i)) {
                best = i;
                rank = r;
            }
        });
        if (best >= 0) {
            at[column] = best;
            used.add(best);
        }
    }
    const extra = row.flatMap((h, i): [number, string][] => (used.has(i) || !clean(h) ? [] : [[i, clean(h)]]));
    const v = at.vendorPn === undefined ? "" : keys[at.vendorPn];
    const vendor = /^(digikey|dkpn)/.test(v) ? "digikey" : v.startsWith("mouser") ? "mouser"
        : v.startsWith("lcsc") ? "lcsc" : "";
    return { at, extra, vendor };
}

/** The heading row among the first ten: the one naming the most columns, one of them saying what a part is. */
function findHeadings(rows: string[][]): { index: number; columns: Columns } | null {
    let found: { index: number; columns: Columns } | null = null;
    let score = 0;
    for (const [index, row] of rows.slice(0, 10).entries()) {
        const columns = mapHeadings(row);
        const n = Object.keys(columns.at).length;
        if (n > score && IDENTITY.some((c) => columns.at[c] !== undefined)) {
            found = { index, columns };
            score = n;
        }
    }
    return found;
}

/** "1,000" is 1000 and "100 pcs" 100; a cell not starting with a digit is no number. */
function number(s: string): number | null {
    const m = /^\d[\d,' ]*/.exec(s);
    return m ? Number(m[0].replace(/[,' ]/g, "")) : null;
}

/** A 53-bit hash of the text (cyrb53) in base 36. */
function hash(text: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The rows of a table that name a part, as items. A row's key comes from what identifies the bag
 * (part numbers, name, code, date code, lot, when it was added), not from counts, places or notes, so
 * a count corrected or a row moved in the sheet is not a new bag.
 */
export function tableRows(t: Table, hints: Record<string, string> = {}, now = Date.now()):
    { rows: ImportRow[]; skipped: number; error: string } {
    const head = findHeadings(t.rows);
    if (!head) {
        return { rows: [], skipped: 0, error: "no heading row naming a part number, a name or a code" };
    }
    const { at, extra, vendor } = head.columns;
    const heading = t.rows[head.index].map(clean).join("\x1f");
    const rows: ImportRow[] = [];
    let skipped = 0;
    for (const raw of t.rows.slice(head.index + 1)) {
        const cells = raw.map(clean);
        if (!cells.some(Boolean) || cells.join("\x1f") === heading) {
            continue;
        }
        const cell = (c: Column) => {
            const i = at[c];
            return i === undefined ? "" : cells[i] ?? "";
        };
        const [mpn, vendorPn, name, code] = IDENTITY.map(cell);
        if (!mpn && !vendorPn && !name && !code) {
            skipped++;
            continue;
        }
        const qty = number(cell("qty"));
        const typed = cell("type");
        const created = Date.parse(cell("created"));
        const item: Partial<Item> = {
            mpn, vendorPn, name, raw: code, qty,
            count: cell("count") ? number(cell("count")) : qty,
            type: TYPES.find((x) => x === typed.toLowerCase()) ?? (typed || hints[familyKey(mpn)] || guessType(mpn)),
            value: cell("value") || valueFromPartNumber(mpn),
            dateCode: cell("dateCode"), lot: cell("lot"), country: cell("country"),
            source: cell("source") || vendor || "import",
            flags: cell("flags").toLowerCase().split(/[\s,;]+/).filter(Boolean),
            notes: [cell("notes"), ...extra.map(([i, h]) => (cells[i] ? `${h}: ${cells[i]}` : ""))]
                .filter(Boolean).join("; "),
            created: Number.isFinite(created) ? created : now,
        };
        const identity = [mpn, vendorPn, name, code, item.dateCode, item.lot, cell("created")].join("\x1f");
        rows.push({ table: t.name, key: hash(identity.toLowerCase()), item, bag: cell("bag"), box: cell("box"),
            shelf: cell("shelf") });
    }
    return { rows, skipped, error: "" };
}

/** A place as a row writes it: "Bag 3: Resistors" is number 3 named Resistors, "Bag 3" number 3, else a name. */
export interface PlaceRef {
    n: number | null;
    name: string;
}

export function placeRef(kind: Kind, text: string): PlaceRef {
    const m = new RegExp(`^${KIND_TITLE[kind]}\\s*(\\d+)(?:\\s*:\\s*(.*))?$`, "i").exec(text.trim());
    return m ? { n: Number(m[1]), name: (m[2] ?? "").trim() } : { n: null, name: text.trim() };
}

function same(a: string, b: string): boolean {
    return a.localeCompare(b, undefined, { sensitivity: "base" }) === 0;
}

/**
 * The existing shelf, box or bag a row means: the one with its number (a printed label) unless both
 * have names and they differ, else one with its name inside parentId: anywhere when that is
 * undefined, in no box (shelf) when it is null.
 */
export function findPlace<T extends { id: string; name: string }>(kind: Kind, ref: PlaceRef, things: T[],
    parentOf: (t: T) => string | null, parentId?: string | null): T | undefined {
    if (ref.n !== null) {
        const id = makeId(kind, ref.n);
        const t = things.find((x) => x.id === id);
        if (t && (!ref.name || !t.name || same(t.name, ref.name))) {
            return t;
        }
    }
    if (!ref.name) {
        return undefined;
    }
    return things.find((x) => same(x.name, ref.name) && (parentId === undefined || parentOf(x) === parentId));
}

/**
 * Imports the tables into the store. Keys count across all the tables of one source
 * ("drive:<folder>", "file:<name>"): the nth row of the same bag identity is the same row each time
 * the source is imported, wherever it has moved in the source.
 */
export async function importTables(store: Pick<Store, "importRows">, tables: Table[], source: string,
    hints: Record<string, string> = {}): Promise<ImportReport> {
    const seen = new Map<string, number>();
    const rows: ImportRow[] = [];
    const owner: number[] = [];
    const reports = tables.map((t, ti): TableReport => {
        const r = tableRows(t, hints);
        for (const row of r.rows) {
            const n = (seen.get(row.key) ?? 0) + 1;
            seen.set(row.key, n);
            rows.push({ ...row, key: `${source}:${row.key}#${n}` });
            owner.push(ti);
        }
        return { name: t.name, added: 0, already: 0, skipped: r.skipped, error: r.error };
    });
    const { added, made } = await store.importRows(rows);
    added.forEach((a, i) => {
        reports[owner[i]][a ? "added" : "already"]++;
    });
    return { tables: reports, made };
}

/** What the Drive script answers. */
interface DriveAnswer {
    ok: boolean;
    error?: string;
    folder?: string;
    tables?: { name: string; csv?: string; rows?: unknown[][] }[];
    errors?: { file: string; error: string }[];
    ignored?: string[];
}

export interface DriveReply {
    folder: string;
    tables: Table[];
    problems: string[]; // files the script could not read, and files that are not CSV or Sheets
}

/**
 * Every CSV file and sheet in the Drive script's folder. A plain GET with no headers of its own: the
 * script cannot answer a CORS preflight, so anything that would need one fails.
 */
export async function fetchDrive(url: string, token: string, get: typeof fetch = fetch): Promise<DriveReply> {
    let u: URL;
    try {
        u = new URL(url.trim());
    } catch {
        throw new Error("the Drive script URL is not a URL");
    }
    u.searchParams.set("token", token.trim());
    let r: Response;
    try {
        r = await get(u.toString(), { signal: AbortSignal.timeout(6 * 60_000) });
    } catch (err) {
        throw new Error(`no answer from the Drive script (${(err as Error).message}); is it deployed for anyone?`);
    }
    let j: DriveAnswer;
    try {
        j = await r.json();
    } catch {
        throw new Error(`the Drive script answered ${r.status} without JSON; is this its /exec URL?`);
    }
    if (!j?.ok) {
        throw new Error(`Drive script: ${j?.error ?? "no answer"}`);
    }
    return {
        folder: String(j.folder ?? ""),
        tables: (j.tables ?? []).map((t) => ({ name: String(t.name),
            rows: Array.isArray(t.rows) ? t.rows.map((row) => row.map((c) => String(c ?? ""))) : parseCsv(t.csv ?? "") })),
        problems: [...(j.errors ?? []).map((e) => `${e.file}: ${e.error}`),
            ...(j.ignored ?? []).map((f) => `${f}: not a CSV file or Google Sheet`)],
    };
}
