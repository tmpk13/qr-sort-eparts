// Edit mode's selection: the tree flattened into rows in display order, and click/shift-click rules.
import { batchTitle, display, isUnidentified, itemName, itemTag, unidentifiedKind, type Bag, type Box, type Data,
    type Item } from "./model.ts";

export type RowKind = "head" | "box" | "bag" | "item";

export interface Row {
    kind: RowKind;
    id: string;
    depth: number;
    label: string;
    item?: Item;
}

/** The whole tree as one list, in the order it is shown, so a shift-click can select a run of it. */
export function editRows(data: Data): Row[] {
    const rows: Row[] = [];
    const bagsIn = (boxId: string | null) => data.bags.filter((b) => b.boxId === boxId)
        .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id, undefined, { numeric: true }));
    const itemsOf = (pred: (i: Item) => boolean) => data.items.filter(pred).sort((a, b) => a.seq - b.seq);
    const addItems = (items: Item[], depth: number) => items.forEach((i) => rows.push({ kind: "item", id: i.id, depth,
        label: `${itemTag(i)} ${itemName(i)}`, item: i }));
    const addBag = (bag: Bag, depth: number) => {
        rows.push({ kind: "bag", id: bag.id, depth, label: display(bag) });
        addItems(itemsOf((i) => i.bagId === bag.id && !isUnidentified(i)), depth + 1);
    };
    const addBox = (box: Box, depth: number) => {
        rows.push({ kind: "box", id: box.id, depth, label: `${box.position != null ? `#${box.position} ` : ""}${display(box)}` });
        bagsIn(box.id).forEach((b) => addBag(b, depth + 1));
    };
    const boxesOn = (shelfId: string | null) => data.boxes.filter((b) => b.shelfId === shelfId)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.created - b.created);
    for (const shelf of data.shelves) {
        rows.push({ kind: "head", id: shelf.id, depth: 0, label: display(shelf) });
        boxesOn(shelf.id).forEach((b) => addBox(b, 1));
    }
    rows.push({ kind: "head", id: "loose", depth: 0, label: "Not placed" });
    boxesOn(null).forEach((b) => addBox(b, 1));
    bagsIn(null).forEach((b) => addBag(b, 1));
    addItems(itemsOf((i) => !i.bagId && !i.batchId && !isUnidentified(i)), 1);
    for (const batch of [...data.batches].sort((a, b) => b.created - a.created)) {
        rows.push({ kind: "head", id: batch.id, depth: 0, label: batchTitle(batch) });
        addItems(itemsOf((i) => i.batchId === batch.id && !i.bagId && !isUnidentified(i)), 1);
    }
    // Records waiting to be identified stay under their own headings wherever they are kept; the label says where.
    const waiting = [["unknown", "code", "Unidentified codes"], ["nocode", "photo", "Unidentified photos"]] as const;
    for (const [id, kind, label] of waiting) {
        const items = itemsOf((i) => unidentifiedKind(i) === kind);
        if (items.length) {
            rows.push({ kind: "head", id, depth: 0, label });
            items.forEach((i) => {
                const bag = data.bags.find((b) => b.id === i.bagId);
                rows.push({ kind: "item", id: i.id, depth: 1, item: i,
                    label: `${itemTag(i)} ${itemName(i)}${bag ? ` (in ${display(bag)})` : ""}` });
            });
        }
    }
    return rows;
}

/** Click toggles one row; shift-click adds every row of the clicked kind between the last click and this one. */
export function selectRows(rows: Row[], selected: Set<string>, anchor: string | null, clicked: Row, shift: boolean): Set<string> {
    const next = new Set(selected);
    const from = anchor ? rows.findIndex((r) => r.id === anchor) : -1;
    const to = rows.findIndex((r) => r.id === clicked.id);
    if (shift && from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        rows.slice(lo, hi + 1).filter((r) => r.kind === clicked.kind).forEach((r) => next.add(r.id));
    } else if (next.has(clicked.id)) {
        next.delete(clicked.id);
    } else {
        next.add(clicked.id);
    }
    return next;
}
