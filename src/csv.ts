// Spreadsheet export: one row per item, its place spelled out, sorted shelf by shelf.
import { batchTitle, display, itemTag, placeOfBag, printable, type Data } from "./model.ts";

export const CSV_COLUMNS = ["id", "type", "name", "mpn", "vendor_pn", "bag_qty", "count", "date_code", "lot",
    "country", "source", "bag", "box", "shelf", "position", "batch", "notes", "code", "created"];

export function csvCell(v: string | number | null | undefined): string {
    let s = v == null ? "" : String(v);
    // Spreadsheets run a cell that starts with = + or @ as a formula.
    if (/^[=+@\t\r]/.test(s)) {
        s = `'${s}`;
    }
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(data: Data): string {
    const rows = data.items.map((item) => {
        const p = placeOfBag(item.bagId, data);
        const batch = data.batches.find((b) => b.id === item.batchId);
        // Placed things first (shelf, then position on it, box, bag), the rest after them.
        const sortKey = [p.shelf ? "0" : "1", display(p.shelf), String(p.box?.position ?? 9999).padStart(4, "0"),
            p.box ? "0" : "1", display(p.box), p.bag ? "0" : "1", display(p.bag), String(item.seq).padStart(8, "0")]
            .join("\t");
        const cells = [itemTag(item), item.type, item.name, item.mpn, item.vendorPn, item.qty, item.count,
            item.dateCode, item.lot, item.country, item.source, display(p.bag), display(p.box), display(p.shelf),
            p.box?.position ?? null, batch ? batchTitle(batch) : "", item.notes, printable(item.raw),
            item.created ? new Date(item.created).toISOString() : ""];
        return { sortKey, cells };
    });
    rows.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    return [CSV_COLUMNS, ...rows.map((r) => r.cells)].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
