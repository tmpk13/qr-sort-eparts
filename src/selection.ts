// Edit mode's selection: the tree flattened into rows in display order, and click/shift-click rules.
import { batchTitle, display, isUnidentified, itemName, itemTag, sortItems, type Bag, type Box, type Data, type Item,
    type ItemOrder } from "./model.ts";

export type RowKind = "head" | "box" | "bag" | "item";

export interface Row {
    kind: RowKind;
    id: string;
    depth: number;
    label: string;
    item?: Item;
}

/**
 * The whole tree as one list, in the order it is shown, so a shift-click can select a run of it.
 * Unidentified items sit where they are, like the rest, marked in their label.
 */
export function editRows(data: Data, order: ItemOrder = "scanned"): Row[] {
    const rows: Row[] = [];
    const bagsIn = (boxId: string | null) => data.bags.filter((b) => b.boxId === boxId)
        .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id, undefined, { numeric: true }));
    const itemsOf = (pred: (i: Item) => boolean) => sortItems(data.items.filter(pred), order);
    const addItems = (items: Item[], depth: number) => items.forEach((i) => rows.push({ kind: "item", id: i.id, depth,
        label: `${itemTag(i)} ${i.value ? `${i.value} ` : ""}${itemName(i)}${isUnidentified(i) ? " (unidentified)" : ""}`,
        item: i }));
    const addBag = (bag: Bag, depth: number) => {
        rows.push({ kind: "bag", id: bag.id, depth, label: display(bag) });
        addItems(itemsOf((i) => i.bagId === bag.id), depth + 1);
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
    addItems(itemsOf((i) => !i.bagId && !i.batchId), 1);
    for (const batch of [...data.batches].sort((a, b) => b.created - a.created)) {
        rows.push({ kind: "head", id: batch.id, depth: 0, label: batchTitle(batch) });
        addItems(itemsOf((i) => i.batchId === batch.id && !i.bagId), 1);
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
