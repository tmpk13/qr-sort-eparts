// The data layer on a fake IndexedDB: ids, shelf positions, deletions, photos and backups.
import "fake-indexeddb/auto";
import { describe, expect, test } from "bun:test";
import { Db } from "../src/db.ts";
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
        expect(backup.counters).toEqual({ shelf: 1, box: 1, bag: 1 });

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
