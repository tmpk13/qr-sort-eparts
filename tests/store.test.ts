// The data layer on a fake IndexedDB: ids, shelf positions, deletions, photos and backups.
import "fake-indexeddb/auto";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { openDB } from "idb";
import { Db, type Backup } from "../src/db.ts";
import { UNIDENTIFIED, type Item } from "../src/model.ts";
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


describe("one record per bag", () => {
    test("items are numbered as they are stored", async () => {
        const s = await fresh();
        await s.saveItem(part(null, { mpn: "A" }));
        await s.saveItem(part(null, { mpn: "B" }));
        expect(s.data.items.map((i) => i.seq).sort()).toEqual([1, 2]);
    });

    test("a second bag of a part is a record of its own; the same label again in the box is not", async () => {
        const s = await fresh();
        const box = await s.createBox();
        const bag1 = await s.createBag("", box.id);
        const bag2 = await s.createBag("", box.id);
        const first = await s.saveItem(part(bag1.id, { mpn: "NE5532ADR", qty: 5, raw: "A" }));
        const second = await s.saveItem(part(bag2.id, { mpn: "ne5532adr", qty: 10, raw: "B" }), new Blob(["p"]));
        expect(second.rescan).toBe(false);
        expect(s.data.items).toHaveLength(2);
        expect(s.item(first.item.id)).toMatchObject({ qty: 5, count: 5, bagId: bag1.id, hasPhoto: false });
        expect(s.item(second.item.id)).toMatchObject({ qty: 10, count: 10, bagId: bag2.id, hasPhoto: true, seq: 2 });

        const again = await s.saveItem(part(bag1.id, { mpn: "NE5532ADR", qty: 10, raw: "B" }));
        expect(again.rescan).toBe(true);
        expect(again.item.id).toBe(second.item.id);
        expect(s.data.items).toHaveLength(2);

        // Another box is another place.
        const box2 = await s.createBox();
        const bag3 = await s.createBag("", box2.id);
        expect((await s.saveItem(part(bag3.id, { mpn: "NE5532ADR", qty: 10, raw: "B" }))).rescan).toBe(false);
        expect(s.data.items).toHaveLength(3);
    });

    test("a scan that does not say what it is goes where it was scanned, flagged unidentified", async () => {
        const s = await fresh();
        const bag = await s.createBag();
        const u = await s.saveItem({ ...blankItem(bag.id), source: "unknown", raw: "https://example.com" });
        expect(u.item).toMatchObject({ bagId: bag.id, flags: [UNIDENTIFIED] });
        expect((await s.saveItem({ ...blankItem(bag.id), source: "unknown", raw: "https://example.com" })).rescan)
            .toBe(true);
        const p = await s.saveItem(blankItem(bag.id), new Blob(["jpeg"]));
        expect(p.item).toMatchObject({ bagId: bag.id, flags: [UNIDENTIFIED], hasPhoto: true });
        // Every photo is a bag of its own.
        expect((await s.saveItem(blankItem(bag.id), new Blob(["jpeg"]))).rescan).toBe(false);
        expect(s.itemsIn(bag.id)).toHaveLength(3);
        expect(s.unidentified("code").map((i) => i.id)).toEqual([u.item.id]);
        expect(s.unidentified("photo")).toHaveLength(2);
        expect(s.unidentifiedIn([bag.id])).toHaveLength(3);
        // A record that says what it is carries no flag.
        expect((await s.saveItem(part(bag.id, { mpn: "X" }))).item.flags).toEqual([]);
        expect((await s.saveItem({ ...blankItem(bag.id), name: "M3 screws" })).item.flags).toEqual([]);
    });

    test("moving unidentified items, or their bag, leaves the flag; a part number or a name clears it", async () => {
        const s = await fresh();
        const bag1 = await s.createBag();
        const bag2 = await s.createBag();
        const box = await s.createBox();
        const u = (await s.saveItem({ ...blankItem(bag1.id), source: "unknown", raw: "hello" })).item;
        const p = (await s.saveItem(blankItem(bag1.id), new Blob(["jpeg"]))).item;
        await s.moveItems([u.id, p.id], bag2.id);
        await s.moveBags([bag2.id], box.id);
        expect(s.item(u.id)).toMatchObject({ bagId: bag2.id, flags: [UNIDENTIFIED] });
        expect(s.item(p.id)).toMatchObject({ bagId: bag2.id, flags: [UNIDENTIFIED] });
        // Notes, a count or another bag do not identify it.
        await s.saveItem({ ...s.item(p.id)!, notes: "white bag", count: 10, bagId: null });
        expect(s.item(p.id)).toMatchObject({ flags: [UNIDENTIFIED], bagId: null, count: 10 });
        // A name does, and the photo stays.
        const named = await s.saveItem({ ...s.item(p.id)!, name: "M3 screws" });
        expect(named.item).toMatchObject({ flags: [], hasPhoto: true });
        expect((await s.db.getPhoto(p.id))?.size).toBe(4);
        // So does a part number, and one already in the box stays a record of its own.
        await s.saveItem(part(bag2.id, { mpn: "NE5532", qty: 5, raw: "K" }));
        await s.saveItem({ ...s.item(u.id)!, mpn: "NE5532", qty: 2 });
        expect(s.item(u.id)).toMatchObject({ flags: [], qty: 2, bagId: bag2.id });
        expect(s.itemsIn(bag2.id)).toHaveLength(2);
        expect(s.unidentified()).toHaveLength(0);
    });

    test("a photo given with a saved record replaces the one it had", async () => {
        const s = await fresh();
        const saved = (await s.saveItem(part(null, { mpn: "X" }), new Blob(["old"]))).item;
        await s.saveItem(s.item(saved.id)!, new Blob(["newer photo"]));
        expect((await s.db.getPhoto(saved.id))?.size).toBe(11);
        expect(s.data.items).toHaveLength(1);
    });

    test("moving items does not combine them with the same part already there", async () => {
        const s = await fresh();
        const box = await s.createBox();
        const bag1 = await s.createBag("", box.id);
        const loose = await s.saveItem(part(null, { mpn: "X", qty: 3, raw: "L" }));
        await s.saveItem(part(bag1.id, { mpn: "X", qty: 7, raw: "K" }));
        await s.moveItems([loose.item.id], bag1.id);
        expect(s.itemsIn(bag1.id).map((i) => `${i.mpn}:${i.qty}`).sort()).toEqual(["X:3", "X:7"]);
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
    test("a batch collects scans, goes into a bag with its unidentified ones, and clears without losing items", async () => {
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
        await s.saveItem(part(null, { mpn: "Z", qty: 4, raw: "b3", batchId: batch.id }));
        await s.saveItem(blankItem(null, batch.id), new Blob(["jpeg"]));
        expect(s.itemsInBatch(batch.id).map((i) => `${i.mpn}:${i.qty}`)).toEqual(["X:2", "Z:4", "Z:4", ":null"]);
        expect(s.itemsIn(null)).toHaveLength(0);

        const r = await s.putBatchInBag(batch.id, bag.id);
        expect(r).toHaveLength(4);
        expect(s.itemsIn(bag.id).map((i) => `${i.mpn}:${i.qty}`)).toEqual(["X:1", "X:2", "Z:4", "Z:4", ":null"]);
        expect(s.unidentifiedIn([bag.id])).toHaveLength(1);

        await s.clearBatch(batch.id);
        expect(s.batch(batch.id)).toBeUndefined();
        expect(s.data.items).toHaveLength(5);
        expect(s.data.items.every((i) => i.batchId === null)).toBe(true);
    });
});

describe("older data", () => {
    test("a version 1 database gets item numbers, counts and flags when opened", async () => {
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
        await old.put("items", { id: "early", bagId: null, mpn: "RC0805FR-0710KL", qty: 5, created: 10, source: "digikey" });
        await old.put("items", { id: "odd", bagId: null, raw: "hello", created: 30, source: "unknown" });
        old.close();
        const s = new Store();
        await s.init(await Db.open(name));
        expect(s.item("early")).toMatchObject({ seq: 1, count: 5, merged: [], batchId: null, flags: [], value: "10k" });
        expect(s.item("late")).toMatchObject({ seq: 2, count: 4 });
        expect(s.item("odd")).toMatchObject({ seq: 3, flags: [UNIDENTIFIED] });
        await s.saveItem(part(null, { mpn: "C" }));
        expect(s.data.items.find((i) => i.mpn === "C")?.seq).toBe(4);
    });

    // A real export kept out of the repository; the test runs where the file is present.
    const sample = "test-data/qr-sort-2026-10-23.json";
    test.skipIf(!existsSync(sample))("a real version 1 backup restores with every bag its own numbered record", async () => {
        const backup = (await Bun.file(sample).json()) as Backup;
        const s = await fresh();
        await s.importBackup(backup);
        expect(s.data.items).toHaveLength(56);
        expect(new Set(s.data.items.map((i) => i.seq)).size).toBe(56);
        expect(s.unidentified()).toHaveLength(0);
        const qty = (mpn: string) => s.data.items.filter((i) => i.mpn === mpn).map((i) => i.qty).sort((a, b) => a! - b!);
        expect(qty("STSPIN250")).toEqual([2, 5, 10]); // three bags, not one record of 17
    });
});

function part(bagId: string | null, fields: Partial<Item>): Item {
    return { ...blankItem(bagId), source: "digikey", ...fields, count: fields.count ?? fields.qty ?? null };
}
