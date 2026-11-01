// qr-sort Drive import: a web app that reads every CSV file and Google Sheet in one Drive folder
// (shared drives included) and answers with their cells as JSON, for qr-sort's "Import from Drive".
//
// Setup, in an Apps Script project (script.google.com) of an account that can read the folder:
//   1. Paste this file as Code.gs. In Project Settings tick "Show appsscript.json in editor" and
//      replace that file with the manifest kept next to this one: it turns on the Drive advanced
//      service (v3) and asks for read-only access to Drive and Sheets.
//   2. Project Settings > Script properties: FOLDER_ID = the folder's id, the last part of its URL
//      (drive.google.com/drive/folders/<id>). RECURSIVE = true reads its subfolders as well.
//   3. Run makeToken from the editor once. It asks for the permissions, stores a random TOKEN and
//      logs it. Run checkFolder to see what qr-sort will get.
//   4. Deploy > New deployment > Web app: execute as Me, access Anyone. Give qr-sort the /exec URL
//      and the token. After editing this file, Deploy > Manage deployments > edit > New version
//      keeps the same URL.
//
// GET <exec URL>?token=<TOKEN>
//   {"ok": true, "folder": "<id>", "read": "<ISO time>",
//    "tables": [{"name", "file", "fileId", "kind": "csv" | "sheet", "sheet", "modified", "url",
//                "csv": "<file text>" (CSV files) or "rows": [["cell", ...], ...] (sheets, as shown)}],
//    "errors": [{"file", "fileId", "error"}],    files that could not be read
//    "ignored": ["<name>", ...]}                  other files in the folder
//   {"ok": false, "error": "..."}                 a wrong or missing token, no FOLDER_ID
//
// Access "Anyone" is what lets a page on another site read the answer (Apps Script sends it with
// Access-Control-Allow-Origin: *, but only to requests without a Google login). The token is what
// keeps the folder private, so keep the URL and the token together like a password.

const SHEET_TYPE = "application/vnd.google-apps.spreadsheet";
const FOLDER_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_TYPE = "application/vnd.google-apps.shortcut";
const CSV_TYPES = ["text/csv", "text/comma-separated-values", "application/csv"];

function doGet(e) {
    const answer = answer_((e && e.parameter) || {});
    return ContentService.createTextOutput(JSON.stringify(answer)).setMimeType(ContentService.MimeType.JSON);
}

/** Stores a new random TOKEN and logs it; running it again replaces the old one. */
function makeToken() {
    const token = Utilities.getUuid().replace(/-/g, "");
    PropertiesService.getScriptProperties().setProperty("TOKEN", token);
    Logger.log("TOKEN = " + token);
    return token;
}

/** Logs what the web app would answer: each table with its row count, then the problems. */
function checkFolder() {
    const r = answer_({ token: PropertiesService.getScriptProperties().getProperty("TOKEN") });
    if (!r.ok) {
        Logger.log("error: " + r.error);
        return r;
    }
    r.tables.forEach((t) => Logger.log(t.name + ": " + (t.rows ? t.rows.length + " rows"
        : t.csv.split(/\r\n|\r|\n/).filter((line) => line.trim()).length + " lines")));
    r.errors.forEach((x) => Logger.log(x.file + ": " + x.error));
    r.ignored.forEach((name) => Logger.log(name + ": not a CSV file or Google Sheet"));
    return r;
}

function answer_(params) {
    try {
        const props = PropertiesService.getScriptProperties();
        const token = (props.getProperty("TOKEN") || "").trim();
        if (!token) {
            throw new Error("TOKEN is not set; run makeToken in the script editor");
        }
        if (String(params.token || "") !== token) {
            throw new Error("wrong or missing token");
        }
        const folderId = (props.getProperty("FOLDER_ID") || "").trim();
        if (!folderId) {
            throw new Error("FOLDER_ID is not set in the script properties");
        }
        const out = { ok: true, folder: folderId, read: new Date().toISOString(), tables: [], errors: [], ignored: [] };
        readFolder_(folderId, "", props.getProperty("RECURSIVE") === "true", out);
        return out;
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

function readFolder_(folderId, path, recursive, out) {
    for (const f of listFolder_(folderId)) {
        const name = path + f.name;
        if (f.mimeType === FOLDER_TYPE) {
            if (recursive) {
                readFolder_(f.id, name + "/", recursive, out);
            }
            continue;
        }
        const csv = CSV_TYPES.includes(f.mimeType) || /\.csv$/i.test(f.name);
        if (f.mimeType !== SHEET_TYPE && !csv) {
            out.ignored.push(name);
            continue;
        }
        try {
            out.tables.push(...(f.mimeType === SHEET_TYPE ? readSheets_(f, name) : [readCsv_(f, name)]));
        } catch (err) {
            out.errors.push({ file: name, fileId: f.id, error: err.message });
        }
    }
}

/** The files and folders in a folder by name, shortcuts replaced by what they point to. */
function listFolder_(folderId) {
    const files = [];
    let pageToken = null;
    do {
        const params = {
            q: "'" + folderId.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "' in parents and trashed = false",
            corpora: "allDrives",
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            pageSize: 1000,
            fields: "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, shortcutDetails)",
        };
        if (pageToken) {
            params.pageToken = pageToken;
        }
        const page = Drive.Files.list(params);
        files.push(...(page.files || []));
        pageToken = page.nextPageToken;
    } while (pageToken);
    return files.map((f) => {
        const target = f.mimeType === SHORTCUT_TYPE && f.shortcutDetails;
        return target ? Object.assign({}, f, { id: target.targetId, mimeType: target.targetMimeType }) : f;
    }).sort((a, b) => a.name.localeCompare(b.name));
}

function meta_(f, name) {
    return { name: name, file: f.name, fileId: f.id, modified: f.modifiedTime || "", url: f.webViewLink || "" };
}

function readCsv_(f, name) {
    return Object.assign(meta_(f, name), {
        kind: "csv",
        sheet: "",
        csv: DriveApp.getFileById(f.id).getBlob().getDataAsString(),
    });
}

/** One table per sheet that is not hidden, named "<file> / <sheet>" when there are several. */
function readSheets_(f, name) {
    const sheets = SpreadsheetApp.openById(f.id).getSheets().filter((s) => !s.isSheetHidden());
    return sheets.map((s) => Object.assign(meta_(f, sheets.length > 1 ? name + " / " + s.getName() : name), {
        kind: "sheet",
        sheet: s.getName(),
        url: (f.webViewLink || "") + "#gid=" + s.getSheetId(),
        rows: s.getDataRange().getDisplayValues(),
    }));
}
