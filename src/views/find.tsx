// Find: search for an item, bag or box, then follow the camera's directions along the shelf.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ledSteady } from "../led.ts";
import { display, guide, itemName, itemTag, parseQrPayload, placeOfBag, placeText, search, sortItems, title, type Bag,
    type Box, type Data, type Hit, type LabelKind } from "../model.ts";
import { goTo } from "../nav.ts";
import { FORMATS_LABELS, type Detection } from "../scanner.ts";
import { useSettings } from "../settings.ts";
import { store, useData } from "../store.ts";
import { CameraPanel, ItemTitle, QtyBadge, Thumb, val, waitingClass } from "../ui.tsx";

interface Target {
    hit: Hit;
    text: string;
    bag: Bag | null;
    box: Box | null;
}

function resolve(hit: Hit | null, data: Data): Target | null {
    if (!hit) {
        return null;
    }
    if (hit.kind === "item") {
        const item = data.items.find((i) => i.id === hit.id);
        if (!item) {
            return null;
        }
        const p = placeOfBag(item.bagId, data);
        const value = item.value ? `${item.value} ` : "";
        return { hit, text: `${itemTag(item)} ${value}${itemName(item)}: ${placeText(p)}`, bag: p.bag, box: p.box };
    }
    if (hit.kind === "bag") {
        const p = placeOfBag(hit.id, data);
        return p.bag ? { hit, text: placeText(p), bag: p.bag, box: p.box } : null;
    }
    const box = data.boxes.find((b) => b.id === hit.id);
    if (!box) {
        return null;
    }
    const shelf = data.shelves.find((s) => s.id === box.shelfId);
    return { hit, text: placeText({ bag: null, box, shelf: shelf ?? null }), bag: null, box };
}

interface Seen {
    kind: LabelKind;
    id: string;
}

export interface Guidance {
    cls: "here" | "wrong" | "";
    arrow: "left" | "right" | "check" | "none";
    text: string;
}

export function guidance(seen: Seen | null, target: Target | null): Guidance | null {
    if (!seen || !target) {
        return null;
    }
    const seenBag = seen.kind === "bag" ? store.bag(seen.id) ?? null : null;
    const seenBox = seen.kind === "box" ? store.box(seen.id) ?? null : store.box(seenBag?.boxId) ?? null;
    if (seenBag && target.bag && seenBag.id === target.bag.id) {
        return { cls: "here", arrow: "check", text: `This is it: ${display(seenBag)}` };
    }
    if (seen.kind === "bag" && !seenBag) {
        return { cls: "wrong", arrow: "none", text: `${title(seen.id)} is not in the database` };
    }
    if (seen.kind === "box" && !seenBox) {
        return { cls: "wrong", arrow: "none", text: `${title(seen.id)} is not in the database` };
    }
    if (!target.box) {
        return { cls: "", arrow: "none", text: `${display(target.bag)} is not in any box yet` };
    }
    if (!seenBox) {
        return { cls: "wrong", arrow: "none", text: `${display(seenBag)} is loose; look for ${display(target.box)}` };
    }
    const g = guide(seenBox, target.box);
    switch (g.kind) {
        case "here":
            return target.bag
                ? { cls: "here", arrow: "check", text: `This box. Look for ${display(target.bag)} inside` }
                : { cls: "here", arrow: "check", text: `This is it: ${display(seenBox)}` };
        case "left":
        case "right":
            return { cls: "", arrow: g.kind, text: `${g.steps} to the ${g.kind}` };
        case "shelf":
            return { cls: "wrong", arrow: "none", text: `Wrong shelf. Go to ${display(store.shelf(g.shelfId))}` };
        default:
            return { cls: "", arrow: "none", text: `${display(target.box)} has no place on a shelf yet` };
    }
}

function Arrow(p: { kind: Guidance["arrow"] }) {
    const d = p.kind === "left" ? "M85 50 H20 M45 25 L20 50 L45 75" : p.kind === "right"
        ? "M15 50 H80 M55 25 L80 50 L55 75" : p.kind === "check" ? "M20 55 L42 77 L82 28" : "";
    return d ? (
        <svg viewBox="0 0 100 100" aria-hidden="true">
            <path d={d} fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round"
                stroke-linejoin="round" />
        </svg>
    ) : null;
}

export function FindView() {
    const data = useData();
    const [q, setQ] = useState("");
    const [hit, setHit] = useState<Hit | null>(null);
    const [cameraOn, setCameraOn] = useState(false);
    const [seen, setSeen] = useState<Seen | null>(null);
    const seenAt = useRef(0);
    const targetRef = useRef<Target | null>(null);

    const hits = useMemo(() => search(q, data), [q, data]);
    const target = resolve(hit, data);
    targetRef.current = target;
    const g = guidance(seen, target);
    useEffect(() => {
        ledSteady(!cameraOn ? "off" : g?.cls === "here" ? "ok" : g?.cls === "wrong" ? "err" : "idle");
    }, [cameraOn, g?.cls]);
    useEffect(() => () => ledSteady("off"), []);

    const onFrame = (dets: Detection[]) => {
        const labels = dets.map((d) => parseQrPayload(d.text)).filter((l): l is Seen => !!l);
        const now = performance.now();
        if (labels.length) {
            seenAt.current = now;
            const t = targetRef.current;
            const pick = labels.find((l) => l.kind === "bag" && l.id === t?.bag?.id)
                ?? labels.find((l) => l.kind === "box") ?? labels[0];
            setSeen((prev) => (prev && prev.id === pick.id ? prev : pick));
        } else {
            setSeen((prev) => (prev && now - seenAt.current > 1500 ? null : prev));
        }
    };

    const seenBag = seen?.kind === "bag" ? store.bag(seen.id) : undefined;
    const seenBox = seen?.kind === "box" ? store.box(seen.id) : undefined;

    return (
        <div class="stack">
            <div class="panel stack">
                <h2 style="margin:0">Find</h2>
                <input type="search" placeholder="Part number, name, type, bag or box..." value={q}
                    onInput={(e) => setQ(val(e))} />
                {q && (
                    <ul class="list">
                        {hits.slice(0, 20).map((h) => {
                            const t = resolve(h, data);
                            return t ? (
                                <li key={h.kind + h.id} class={`clickable${hit?.id === h.id ? " selected" : ""}`}
                                    onClick={() => setHit(h)}>
                                    <div class="grow">
                                        <div class="title">{t.text.split(": ")[0]}</div>
                                        <div class="small muted">{t.text.includes(": ") ? t.text.split(": ").slice(1).join(": ") : h.kind}</div>
                                    </div>
                                    <span class="badge">{h.kind}</span>
                                    {h.kind === "item" && (
                                        <button class="btn small" onClick={(e) => {
                                            e.stopPropagation();
                                            goTo("browse", { itemId: h.id });
                                        }}>Open</button>
                                    )}
                                </li>
                            ) : null;
                        })}
                        {!hits.length && <li class="muted">No matches</li>}
                    </ul>
                )}
            </div>

            {target && (
                <div class="panel target">
                    <div class="row between">
                        <div>
                            <div class="small muted">Looking for</div>
                            <div class="title">{target.text}</div>
                        </div>
                        <div class="row">
                            {target.hit.kind === "item" && (
                                <button class="btn small" onClick={() => goTo("browse", { itemId: target.hit.id })}>
                                    Open in Browse
                                </button>
                            )}
                            <button class="btn small" onClick={() => setHit(null)}>Clear</button>
                        </div>
                    </div>
                </div>
            )}

            <div class="panel stack">
                <CameraPanel active={cameraOn} onToggle={() => setCameraOn((on) => !on)} formats={FORMATS_LABELS}
                    onFrame={onFrame} highlight={(d) => (parseQrPayload(d.text)?.id === target?.box?.id
                        || parseQrPayload(d.text)?.id === target?.bag?.id ? "#859900" : "#268bd2")}
                    status={target ? "Point at the box labels on the shelf" : "Point at a bag or box label to see what is in it"}>
                    {g && (
                        <div class={`guide ${g.cls}`}>
                            <Arrow kind={g.arrow} />
                            <div>{g.text}</div>
                        </div>
                    )}
                </CameraPanel>
                <div class="row">
                    <button class="btn primary" onClick={() => setCameraOn((on) => !on)}>
                        {cameraOn ? "Stop camera" : "Start camera"}
                    </button>
                    <span class="hint">Boxes are numbered left to right along each shelf.</span>
                </div>
            </div>

            {!target && seen && (
                <div class="panel">
                    <h2>{seenBag ? display(seenBag) : seenBox ? display(seenBox) : `${title(seen.id)} is not in the database`}</h2>
                    {seenBag && <p class="hint">{placeText(placeOfBag(seenBag.id, data))}</p>}
                    {seenBag && <ItemList bagId={seenBag.id} onPick={(id) => goTo("browse", { itemId: id })} />}
                    {seenBox && (
                        <ul class="list">
                            {store.bagsIn(seenBox.id).map((b) => (
                                <li key={b.id}>
                                    <div class="grow"><div class="title">{display(b)}</div></div>
                                    <span class="badge">{store.itemsIn(b.id).length} items</span>
                                </li>
                            ))}
                            {!store.bagsIn(seenBox.id).length && <li class="muted">Empty box</li>}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}

export function ItemList(p: { bagId: string; onPick?: (id: string) => void; focus?: string | null }) {
    const [s] = useSettings();
    const items = sortItems(store.itemsIn(p.bagId), s.sortItems);
    return (
        <ul class="list">
            {items.map((item) => (
                <li key={item.id} class={`${p.onPick ? "clickable" : ""}${p.focus === item.id ? " focused" : ""} ${
                    waitingClass(item)}`} onClick={() => p.onPick?.(item.id)}>
                    <Thumb item={item} />
                    <div class="grow">
                        <ItemTitle item={item} />
                        <div class="small muted">{[item.type, item.vendorPn, item.dateCode].filter(Boolean).join(" / ")}</div>
                    </div>
                    <QtyBadge item={item} />
                </li>
            ))}
            {!items.length && <li class="muted">Empty bag</li>}
        </ul>
    );
}
