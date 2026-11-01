// The import panel in Settings: every CSV file and Google Sheet in a Drive folder, through the Drive
// script's web app, or one CSV file from this computer. Rows imported before are left out, so
// importing the same folder again only adds what is new in it.
import { useState } from "preact/hooks";
import { fetchDrive, importTables, parseCsv, type ImportReport } from "../importer.ts";
import { useSettings } from "../settings.ts";
import { store } from "../store.ts";
import { Field, toast, val } from "../ui.tsx";

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

function summary(r: ImportReport): string {
    const sum = (k: "added" | "already" | "skipped") => r.tables.reduce((n, t) => n + t[k], 0);
    const made = [plural(r.made.shelves, "shelf", "shelves"), plural(r.made.boxes, "box", "boxes"),
        plural(r.made.bags, "bag")].filter((s) => !s.startsWith("0 "));
    return `${plural(sum("added"), "item")} added, ${sum("already")} imported before, ${sum("skipped")} rows skipped`
        + (made.length ? `; made ${made.join(", ")}` : "");
}

export function ImportPanel() {
    const [s, setS] = useSettings();
    const [busy, setBusy] = useState("");
    const [report, setReport] = useState<ImportReport | null>(null);
    const [problems, setProblems] = useState<string[]>([]);

    const run = async (what: string, fn: () => Promise<{ report: ImportReport; problems: string[] }>) => {
        setBusy(what);
        try {
            const r = await fn();
            setReport(r.report);
            setProblems(r.problems);
            toast(summary(r.report), r.report.tables.some((t) => t.added) ? "ok" : "info");
        } catch (err) {
            toast((err as Error).message, "err");
        } finally {
            setBusy("");
        }
    };

    const fromDrive = () => run("Reading the folder...", async () => {
        const reply = await fetchDrive(s.driveUrl, s.driveToken);
        setBusy("Importing...");
        return { report: await importTables(store, reply.tables, `drive:${reply.folder}`, s.typeHints),
            problems: reply.problems };
    });

    const fromFile = (f: File) => run("Importing...", async () => ({
        report: await importTables(store, [{ name: f.name, rows: parseCsv(await f.text()) }], `file:${f.name}`,
            s.typeHints),
        problems: [],
    }));

    return (
        <div class="panel stack">
            <h2 style="margin:0">Import</h2>
            <div class="grid">
                <Field label="Drive script URL (ends in /exec)" wide>
                    <input value={s.driveUrl} placeholder="https://script.google.com/macros/s/.../exec"
                        onInput={(e) => setS({ driveUrl: val(e) })} />
                </Field>
                <Field label="Token">
                    <input type="password" autocomplete="off" value={s.driveToken}
                        onInput={(e) => setS({ driveToken: val(e) })} />
                </Field>
            </div>
            <div class="row">
                <button class="btn primary" onClick={fromDrive} disabled={!!busy || !s.driveUrl || !s.driveToken}>
                    Import from Drive
                </button>
                <label class={`btn${busy ? " disabled" : ""}`}>
                    Import CSV file
                    <input type="file" accept=".csv,text/csv" hidden disabled={!!busy} onChange={(e) => {
                        const input = e.currentTarget as HTMLInputElement;
                        const f = input.files?.[0];
                        input.value = "";
                        if (f) {
                            void fromFile(f);
                        }
                    }} />
                </label>
                {busy && <span class="badge">{busy}</span>}
            </div>
            {report && (
                <div class="stack">
                    <p class="small" style="margin:0">{summary(report)}</p>
                    <ul class="list small">
                        {report.tables.map((t) => (
                            <li>
                                <span class="grow">{t.name}</span>
                                {t.error ? <span class="badge err">{t.error}</span> : (
                                    <span class="muted">
                                        {t.added} added, {t.already} before{t.skipped ? `, ${t.skipped} skipped` : ""}
                                    </span>
                                )}
                            </li>
                        ))}
                        {problems.map((p) => <li><span class="grow muted">{p}</span></li>)}
                    </ul>
                </div>
            )}
            <p class="hint">
                Columns are matched by their headings: qr-sort's own CSV, and distributors' order exports (part
                numbers, description, quantity); other columns go in the notes. Rows go in the bag, box and shelf
                they name ("Bag 3", "Bag 3: Resistors" or a name), which are made when missing; rows naming no bag
                go in a bag named after their file. A row imported once is not imported again, even when its count
                changes or it moves in the sheet.
            </p>
        </div>
    );
}
