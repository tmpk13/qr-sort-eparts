// The marker panel in Settings: counts written on bags with a colored marker are read by isolating
// that color. The color is picked by clicking the writing in a picture; the picture next to it
// shows only what matches, and the sliders set how loosely it matches.
import { useEffect, useRef, useState } from "preact/hooks";
import { isolatedRgba, loadPixels, markerInk, readMarkerCount, sampleColor, tuneFor, type MarkerTune }
    from "../marker.ts";
import { warmUp } from "../ocr.ts";
import { useSettings } from "../settings.ts";
import { store } from "../store.ts";
import { Field, Toggle, toast, val } from "../ui.tsx";

export function MarkerPanel() {
    const [s, setS] = useSettings();
    const [img, setImg] = useState<ImageData | null>(null);
    const [result, setResult] = useState("");
    const [reading, setReading] = useState(false);
    const shown = useRef<HTMLCanvasElement>(null);
    const preview = useRef<HTMLCanvasElement>(null);
    const t = s.marker;

    const tune = (patch: Partial<MarkerTune>) => t && setS({ marker: { ...t, ...patch } });

    useEffect(() => {
        const c = shown.current;
        if (c && img) {
            c.width = img.width;
            c.height = img.height;
            c.getContext("2d")!.putImageData(img, 0, 0);
        }
    }, [img]);

    // The isolated color, redrawn at most once a frame while a slider moves.
    useEffect(() => {
        const c = preview.current;
        if (!c || !img || !t) {
            return;
        }
        const frame = requestAnimationFrame(() => {
            const { mask, box } = markerInk(img, t);
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext("2d")!;
            ctx.putImageData(new ImageData(isolatedRgba(img.data, mask), img.width, img.height), 0, 0);
            if (box) {
                // What the count is read from.
                ctx.strokeStyle = "#268bd2";
                ctx.lineWidth = Math.max(2, img.width / 300);
                ctx.strokeRect(box.x - 4, box.y - 4, box.w + 8, box.h + 8);
            }
        });
        return () => cancelAnimationFrame(frame);
    }, [img, t]);

    const load = async (blob: Blob | undefined | null) => {
        if (!blob) {
            toast("No photo to use yet: save a bag with a photo first, or choose a picture");
            return;
        }
        try {
            setImg(await loadPixels(blob));
            setResult("");
            warmUp();
        } catch (err) {
            toast(`Could not open that picture: ${(err as Error).message}`, "err");
        }
    };

    const lastPhoto = async () => {
        const item = store.data.items.filter((i) => i.hasPhoto).sort((a, b) => b.updated - a.updated)[0];
        await load(item ? await store.db.getPhoto(item.id) : null);
    };

    const pick = (e: MouseEvent) => {
        const c = shown.current;
        if (!c || !img) {
            return;
        }
        const r = c.getBoundingClientRect();
        const x = Math.min(img.width - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * img.width)));
        const y = Math.min(img.height - 1, Math.max(0, Math.round(((e.clientY - r.top) / r.height) * img.height)));
        const next = tuneFor(sampleColor(img.data, img.width, img.height, x, y));
        setS({ marker: t ? { ...next, speck: t.speck } : next });
        setResult("");
    };

    const test = async () => {
        if (!img || !t) {
            return;
        }
        setReading(true);
        try {
            const read = await readMarkerCount(img, t);
            setResult(read ? `Read ${read.count} at ${Math.round(read.confidence)}% confidence`
                : "No number found in that color");
        } catch (err) {
            setResult(`Reading failed: ${(err as Error).message}`);
        } finally {
            setReading(false);
        }
    };

    return (
        <div class="panel stack marker">
            <h2 style="margin:0">Marker count</h2>
            <p class="hint">
                Write the current count on each bag with a colored marker. Pick that color by clicking the
                writing in a picture of a bag; the second picture shows only what matches, with a box around what
                the count is read from. Red, blue or green read best: black looks like the printed label.
            </p>
            <Toggle label="Read the count written in this color when a bag is saved" value={s.readMarker && !!t}
                onChange={(v) => setS({ readMarker: v })} />
            <div class="row">
                <button class="btn" onClick={lastPhoto}>Use the last photo</button>
                <label class="btn">
                    Choose a picture
                    <input type="file" accept="image/*" hidden onChange={(e) => {
                        const input = e.currentTarget as HTMLInputElement;
                        const f = input.files?.[0];
                        input.value = "";
                        if (f) {
                            void load(f);
                        }
                    }} />
                </label>
                {t && (
                    <span class="row">
                        <span class="swatch" style={`background:${t.color}`} aria-hidden="true" />
                        <span class="mono small">{t.color}</span>
                    </span>
                )}
            </div>
            {img && (
                <div class="marker-views">
                    <figure>
                        <canvas ref={shown} class="marker-pick" onClick={pick} aria-label="Picture: click the writing" />
                        <figcaption class="small muted">Click the marker writing</figcaption>
                    </figure>
                    <figure>
                        <canvas ref={preview} class="marker-preview" aria-label="Only the marker color" />
                        <figcaption class="small muted">{t ? "Only the marker color" : "Pick a color first"}</figcaption>
                    </figure>
                </div>
            )}
            {t && (
                <div class="grid">
                    <Field label={`Hue: ${t.hue} degrees`}>
                        <input type="range" min="0" max="359" value={t.hue} onInput={(e) => tune({ hue: Number(val(e)) })} />
                    </Field>
                    <Field label={`Hue range: give or take ${t.hueRange} degrees`}>
                        <input type="range" min="0" max="180" value={t.hueRange}
                            onInput={(e) => tune({ hueRange: Number(val(e)) })} />
                    </Field>
                    <Field label={`Saturation at least ${t.satMin}%`}>
                        <input type="range" min="0" max="100" value={t.satMin} onInput={(e) => tune({ satMin: Number(val(e)) })} />
                    </Field>
                    <Field label={`Brightness from ${t.valMin}%`}>
                        <input type="range" min="0" max="100" value={t.valMin}
                            onInput={(e) => tune({ valMin: Math.min(Number(val(e)), t.valMax) })} />
                    </Field>
                    <Field label={`Brightness up to ${t.valMax}%`}>
                        <input type="range" min="0" max="100" value={t.valMax}
                            onInput={(e) => tune({ valMax: Math.max(Number(val(e)), t.valMin) })} />
                    </Field>
                    <Field label={`Drop specks smaller than ${t.speck} pixels`}>
                        <input type="range" min="0" max="400" step="5" value={t.speck}
                            onInput={(e) => tune({ speck: Number(val(e)) })} />
                    </Field>
                    <Field label={`Use counts read at ${s.markerConfidence}% confidence or more`}>
                        <input type="range" min="0" max="100" step="5" value={s.markerConfidence}
                            onInput={(e) => setS({ markerConfidence: Number(val(e)) })} />
                    </Field>
                </div>
            )}
            {t && (
                <div class="row">
                    <button class="btn" disabled={!img || reading} onClick={test}>{reading ? "Reading..." : "Read count"}</button>
                    {result && <span class="badge" role="status">{result}</span>}
                    <button class="btn" onClick={() => setS({ marker: null, readMarker: false })}>Forget the color</button>
                </div>
            )}
        </div>
    );
}
