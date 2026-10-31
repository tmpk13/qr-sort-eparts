// The data layer on a fake IndexedDB: ids, shelf positions, deletions, photos and backups.
import "fake-indexeddb/auto";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { openDB } from "idb";
import { Db, type Backup } from "../src/db.ts";
import type { Item } from "../src/model.ts";
import { blankItem, Store } from "../src/store.ts";

async function fresh(): Promise<Store> {
    const s = new Store();
    await s.init(await Db.open(`test-${crypto.randomUUID()}`));
    return s;
}

describe("store", () => {
    test("ids count up per kind", async () => {
        const s = await fresh();
        expect((await s.createShelf("A")).id).toBe("shelf-1");
        expect((await s.createShelf("B")).id).toBe("shelf-2");
        expect((await s.createBox()).id).toBe("box-1");
        expect((await s.createBag()).id).toBe("bag-1");
        expect(s.data.shelves.map((x) => x.name)).toEqual(["A", "B"]);
    });

    test("boxes are numbered along a shelf and renumbered when moved", async () => {
        const s = await fresh();
        const sh = await s.createShelf("A");
        const b1 = await s.createBox("", sh.id);
        const b2 = await s.createBox("", sh.id);
        const b3 = await s.createBox("", sh.id);
        const order = (shelf: string) => s.boxesOn(shelf).map((b) => `${b.id}@${b.position}`);
        expect(order(sh.id)).toEqual(["box-1@1", "box-2@2", "box-3@3"]);

        await s.moveBox(b3.id, sh.id, 1);
        expect(order(sh.id)).toEqual(["box-3@1", "box-1@2", "box-2@3"]);

        await s.moveBox(b1.id, null, null);
        expect(order(sh.id)).toEqual(["box-3@1", "box-2@2"]);
        expect(s.box(b1.id)).toMatchObject({ shelfId: null, position: null });

        const sh2 = await s.createShelf("B");
        await s.moveBox(b2.id, sh2.id, 5);
        expect(order(sh.id)).toEqual(["box-3@1"]);
        expect(order(sh2.id)).toEqual(["box-2@1"]);

        await s.moveBox(b1.id, sh2.id, 1);
        expect(order(sh2.id)).toEqual(["box-1@1", "box-2@2"]);
        const unplaced = await s.createBox();
        expect(unplaced.position).toBeNull();
        expect(s.boxesOn(null).map((b) => b.id)).toEqual([unplaced.id]);
    });

    test("concurrent creations still get distinct positions", async () => {
        const s = await fresh();
        const sh = await s.createShelf();
        await Promise.all([s.createBox("a", sh.id), s.createBox("b", sh.id), s.createBox("c", sh.id)]);
        expect(s.boxesOn(sh.id).map((b) => b.position)).toEqual([1, 2, 3]);
    });

    test("deleting containers unlinks what is below, deleting a bag removes its items", async () => {
        const s = await fresh();
        const sh = await s.createShelf();
        const box = await s.createBox("", sh.id);
        const bag = await s.createBag("", box.id);
        const other = await s.createBag("", box.id);
        await s.saveItem(blankItem(bag.id));
        await s.saveItem(blankItem(other.id));
        await s.deleteShelf(sh.id);
        expect(s.box(box.id)).toMatchObject({ shelfId: null, position: null });
        await s.deleteBox(box.id);
        expect(s.bag(bag.id)?.boxId).toBeNull();
        await s.deleteBag(bag.id);
        expect(s.data.bags.map((b) => b.id)).toEqual([other.id]);
        expect(s.data.items).toHaveLength(1);
        expect(s.data.items[0].bagId).toBe(other.id);
    });

    test("photos follow their items", async () => {
        const s = await fresh();
        const item = blankItem(null);
        await s.saveItem(item, new Blob(["jpeg bytes"], { type: "image/jpeg" }));
        expect(s.item(item.id)?.hasPhoto).toBe(true);
        expect((await s.db.getPhoto(item.id))?.size).toBe(10);
        await s.saveItem({ ...s.item(item.id)!, name: "edited" });
        expect((await s.db.getPhoto(item.id))?.size).toBe(10);
        await s.deleteItem(item.id);
        expect(await s.db.getPhoto(item.id)).toBeUndefined();
        expect(s.data.items).toHaveLength(0);
    });

    test("backups round trip without photos and keep the id counters", async () => {
        const s = await fresh();
        const sh = await s.createShelf("A");
        const box = await s.createBox("Caps", sh.id);
        const bag = await s.createBag("", box.id);
        const item = { ...blankItem(bag.id), mpn: "CL21A106KAYNNNE", qty: 50 };
        await s.saveItem(item, new Blob(["x"]));
        const backup = await s.exportBackup();
        expect(backup.app).toBe("qr-sort");
        expect(backup.counters).toEqual({ shelf: 1, box: 1, bag: 1, item: 1 });
        expect(backup.version).toBe(2);

        const t = await fresh();
        await t.importBackup(JSON.parse(JSON.stringify(backup)));
        expect(t.data.boxes[0]).toMatchObject({ id: "box-1", name: "Caps", shelfId: "shelf-1", position: 1 });
        expect(t.data.items[0]).toMatchObject({ mpn: "CL21A106KAYNNNE", qty: 50, hasPhoto: false });
        expect((await t.createBox()).id).toBe("box-2");
        await expect(t.importBackup({ app: "other" } as never)).rejects.toThrow(/not a qr-sort backup/);

        await t.clearAll();
        expect(t.data.items).toHaveLength(0);
        expect((await t.createShelf()).id).toBe("shelf-1");
    });
});

function part(bagId: string | null, fields: Partial<Item>): Item {
    return { ...blankItem(bagId), source: "digikey", ...fields, count: fields.count ?? fields.qty ?? null };
}

describe("one record per part in a box", () => {
    test("items are numbered as they are stored", async () => {
        const s = await fresh();
        await s.saveItem(part(null, { mpn: "A" }));
        await s.saveItem(part(null, { mpn: "B" }));
        expect(s.data.items.map((i) => i.seq).sort()).toEqual([1, 2]);
    });

    test("a second bag of a part adds to the record in that box, in whichever bag it is", async () => {
        const s = await fresh();
        const box = await s.createBox();
        const bag1 = await s.createBag("", box.id);
        const bag2 = await s.createBag("", box.id);
        const first = await s.saveItem(part(bag1.id, { mpn: "NE5532ADR", qty: 5, raw: "A" }));
        expect(first.into).toBeNull();
        const second = await s.saveItem(part(bag2.id, { mpn: "ne5532adr", qty: 10, raw: "B", country: "MX" }),
            new Blob(["p"]));
        expect(second.into?.id).toBe(first.item.id);
        expect(second.rescan).toBe(false);
        expect(s.data.items).toHaveLength(1);
        expect(s.data.items[0]).toMatchObject({ bagId: bag1.id, qty: 15, count: 15, country: "MX", merged: ["B"], seq: 1,
            hasPhoto: true });
        expect((await s.db.getPhoto(first.item.id))?.size).toBe(1);

        const again = await s.saveItem(part(bag2.id, { mpn: "NE5532ADR", qty: 10, raw: "B" }));
        expect(again.rescan).toBe(true);
        expect(s.data.items[0].qty).toBe(15);

        // Another box is another place.
        const box2 = await s.createBox();
        const bag3 = await s.createBag("", box2.id);
        expect((await s.saveItem(part(bag3.id, { mpn: "NE5532ADR", qty: 1 }))).into).toBeNull();
        expect(s.data.items).toHaveLength(2);
    });

    test("unidentified scans keep to themselves and are listed once per code", async () => {
        const s = await fresh();
        const bag = await s.createBag();
        await s.saveItem(part(bag.id, { mpn: "X" }));
        const u = { ...blankItem(null), source: "unknown", raw: "https://example.com" };
        await s.saveItem(u);
        expect((await s.saveItem({ ...u, id: crypto.randomUUID() })).rescan).toBe(true);
        expect(s.unidentified().map((i) => i.raw)).toEqual(["https://example.com"]);
        expect(s.itemsIn(null)).toHaveLength(0);
    });

    test("photos of bags with no code are listed apart from codes, one record per photo", async () => {
        const s = await fresh();
        const u = await s.saveItem({ ...blankItem(null), source: "unknown", raw: "hello" });
        const p1 = await s.saveItem({ ...blankItem(null), source: "photo" }, new Blob(["jpeg"]));
        const p2 = await s.saveItem({ ...blankItem(null), source: "photo" }, new Blob(["jpeg"]));
        expect(p2.into).toBeNull();
        expect(s.unidentified("code").map((i) => i.id)).toEqual([u.item.id]);
        expect(s.unidentified("photo").map((i) => i.id).sort()).toEqual([p1.item.id, p2.item.id].sort());
        expect(s.unidentified()).toHaveLength(3);
        expect(s.item(p1.item.id)?.hasPhoto).toBe(true);
    });

    test("putting unidentified records in a bag, or their bag in a box, leaves them waiting", async () => {
        const s = await fresh();
        const bag = await s.createBag();
        const box = await s.createBox();
        const u = (await s.saveItem({ ...blankItem(null), source: "unknown", raw: "hello" })).item;
        const p = (await s.saveItem({ ...blankItem(null), source: "photo" }, new Blob(["jpeg"]))).item;
        await s.moveItems([u.id, p.id], bag.id);
        await s.moveBags([bag.id], box.id);
        expect(s.item(u.id)).toMatchObject({ bagId: bag.id, source: "unknown" });
        expect(s.item(p.id)).toMatchObject({ bagId: bag.id, source: "photo" });
        expect(s.unidentified()).toHaveLength(2);
        expect(s.unidentifiedIn([bag.id])).toHaveLength(2);
        expect(s.itemsIn(bag.id)).toHaveLength(0);
        // Notes, a count or a bag picked in the item dialog do not identify it either.
        await s.saveItem({ ...s.item(p.id)!, notes: "white bag", count: 10, bagId: null });
        expect(s.item(p.id)).toMatchObject({ source: "photo", bagId: null, count: 10 });
        expect(s.unidentified("photo")).toHaveLength(1);
    });

    test("a part number or a name identifies a waiting record, which then files like any item", async () => {
        const s = await fresh();
        const box = await s.createBox();
        const bag1 = await s.createBag("", box.id);
        const bag2 = await s.createBag("", box.id);
        const kept = (await s.saveItem(part(bag1.id, { mpn: "NE5532", qty: 5, raw: "K" }))).item;
        const p = (await s.saveItem({ ...blankItem(null), source: "photo" }, new Blob(["jpeg"]))).item;
        const u = (await s.saveItem({ ...blankItem(null), source: "unknown", raw: "hello" })).item;
        await s.moveItems([p.id, u.id], bag2.id);

        const named = await s.saveItem({ ...s.item(p.id)!, name: "M3 screws" });
        expect(named.item).toMatchObject({ id: p.id, source: "manual", bagId: bag2.id, hasPhoto: true });
        expect(s.itemsIn(bag2.id).map((i) => i.id)).toEqual([p.id]);
        expect((await s.db.getPhoto(p.id))?.size).toBe(4);

        // Identified as a part already in the box: merged into that record like a second bag of it.
        const merged = await s.saveItem({ ...s.item(u.id)!, mpn: "ne5532", qty: 2 });
        expect(merged.into?.id).toBe(kept.id);
        expect(s.item(kept.id)).toMatchObject({ qty: 7, merged: ["hello"] });
        expect(s.item(u.id)).toBeUndefined();
        expect(s.unidentified()).toHaveLength(0);
    });

    test("moving items merges them into the record already in the target box", async () => {
        const s = await fresh();
        const box = await s.createBox();
        const bag1 = await s.createBag("", box.id);
        const loose = await s.saveItem(part(null, { mpn: "X", qty: 3, raw: "L" }));
        const other = await s.saveItem(part(null, { mpn: "Y", qty: 1, raw: "M" }));
        const kept = await s.saveItem(part(bag1.id, { mpn: "X", qty: 7, raw: "K" }));
        const r = await s.moveItems([loose.item.id, other.item.id], bag1.id);
        expect(r.map((x) => x.into?.id ?? null)).toEqual([kept.item.id, null]);
        expect(s.data.items.map((i) => `${i.mpn}:${i.qty}:${i.bagId === bag1.id}`).sort()).toEqual(["X:10:true", "Y:1:true"]);
    });

    test("bags move to boxes and boxes to the end of a shelf", async () => {
        const s = await fresh();
        const sh = await s.createShelf();
        const existing = await s.createBox("", sh.id);
        const a = await s.createBox();
        const b = await s.createBox();
        await s.moveBoxes([b.id, a.id], sh.id);
        expect(s.boxesOn(sh.id).map((x) => x.id)).toEqual([existing.id, b.id, a.id]);
        const bag1 = await s.createBag();
        const bag2 = await s.createBag();
        await s.moveBags([bag1.id, bag2.id], a.id);
        expect(s.bagsIn(a.id).map((x) => x.id)).toEqual([bag1.id, bag2.id]);
        await s.moveBoxes([a.id], null);
        expect(s.box(a.id)).toMatchObject({ shelfId: null, position: null });
    });
});

describe("batches", () => {
    test("a batch collects scans, goes into a bag, and clears without losing items", async () => {
        const s = await fresh();
        const batch = await s.createBatch();
        expect(batch.id).toBe("batch-1");
        expect(batch.code).toMatch(/^[A-Z2-9]{4}$/);
        expect((await s.createBatch()).code).not.toBe(""); // codes are random; ids still count up
        const box = await s.createBox();
        const bag = await s.createBag("", box.id);
        await s.saveItem(part(bag.id, { mpn: "X", qty: 1, raw: "old" }));
        await s.saveItem(part(null, { mpn: "X", qty: 2, raw: "b1", batchId: batch.id }));
        await s.saveItem(part(null, { mpn: "Z", qty: 4, raw: "b2", batchId: batch.id }));
        // Within the batch, a part is one record too.
        await s.saveItem(part(null, { mpn: "Z", qty: 4, raw: "b3", batchId: batch.id }));
        expect(s.itemsInBatch(batch.id).map((i) => `${i.mpn}:${i.qty}`)).toEqual(["X:2", "Z:8"]);
        expect(s.itemsIn(null)).toHaveLength(0);

        const r = await s.putBatchInBag(batch.id, bag.id);
        expect(r.filter((x) => x.into).length).toBe(1);
        expect(s.itemsIn(bag.id).map((i) => `${i.mpn}:${i.qty}`)).toEqual(["X:3", "Z:8"]);

        await s.clearBatch(batch.id);
        expect(s.batch(batch.id)).toBeUndefined();
        expect(s.data.items).toHaveLength(2);
        expect(s.data.items.every((i) => i.batchId === null)).toBe(true);
    });
});

describe("older data", () => {
    test("a version 1 database gets item numbers and counts when opened", async () => {
        const name = `v1-${crypto.randomUUID()}`;
        const old = await openDB(name, 1, {
            upgrade(db) {
                db.createObjectStore("shelves", { keyPath: "id" });
                db.createObjectStore("boxes", { keyPath: "id" }).createIndex("shelfId", "shelfId");
                db.createObjectStore("bags", { keyPath: "id" }).createIndex("boxId", "boxId");
                db.createObjectStore("items", { keyPath: "id" }).createIndex("bagId", "bagId");
                db.createObjectStore("photos");
                db.createObjectStore("counters");
            },
        });
        await old.put("items", { id: "late", bagId: null, mpn: "B", qty: 4, created: 20, source: "digikey" });
        await old.put("items", { id: "early", bagId: null, mpn: "A", qty: 5, created: 10, source: "digikey" });
        old.close();
        const s = new Store();
        await s.init(await Db.open(name));
        expect(s.item("early")).toMatchObject({ seq: 1, count: 5, merged: [], batchId: null });
        expect(s.item("late")).toMatchObject({ seq: 2, count: 4 });
        await s.saveItem(part(null, { mpn: "C" }));
        expect(s.data.items.find((i) => i.mpn === "C")?.seq).toBe(3);
    });

    // A real export kept out of the repository; the test runs where the file is present.
    const sample = "test-data/qr-sort-2026-10-23.json";
    test.skipIf(!existsSync(sample))("a real version 1 backup restores, numbers its items and merges its duplicates", async () => {
        const backup = (await Bun.file(sample).json()) as Backup;
        const s = await fresh();
        await s.importBackup(backup);
        expect(s.data.items).toHaveLength(56);
        expect(new Set(s.data.items.map((i) => i.seq)).size).toBe(56);
        const merged = await s.mergeDuplicates();
        expect(merged).toBe(56 - 41);
        expect(s.data.items).toHaveLength(41);
        const qty = (mpn: string) => s.data.items.find((i) => i.mpn === mpn)?.qty;
        expect(qty("STSPIN250")).toBe(17); // three bags: 5 + 2 + 10
        expect(qty("MIC842LYC5-TR")).toBe(10); // the same label scanned twice
        // Merging keeps the oldest record.
        const oldest = Math.min(...backup.items.filter((i) => i.mpn === "NE5532ADR").map((i) => i.created));
        expect(s.data.items.find((i) => i.mpn === "NE5532ADR")?.created).toBe(oldest);
    });
});
