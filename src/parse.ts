// Decoding of the codes found on parts bags: DigiKey and Mouser labels (ISO 15434 format "06"
// in a Data Matrix), LCSC bags (brace-delimited QR code) and anything else as plain text.

export type Source = "digikey" | "mouser" | "lcsc" | "iso15434" | "text";

export interface Parsed {
    source: Source;
    mpn: string;
    vendorPn: string;
    qty: number | null;
    dateCode: string;
    lot: string;
    country: string;
    manufacturer: string;
    notes: string;
    fields: Record<string, string>; // every field as found, keyed by data identifier
    raw: string;
}

const RS = "\x1e";
const GS = "\x1d";
const EOT = "\x04";

function empty(source: Source, raw: string): Parsed {
    return { source, mpn: "", vendorPn: "", qty: null, dateCode: "", lot: "", country: "",
        manufacturer: "", notes: "", fields: {}, raw };
}

function num(s: string | undefined): number | null {
    const m = /^\d+$/.exec((s ?? "").trim());
    return m ? Number(m[0]) : null;
}

export function parseCode(text: string): Parsed {
    return parseIso15434(text) ?? parseLcsc(text) ?? empty("text", text);
}

/** Readers in "human readable" mode spell the separators out; map them back to the control codes. */
function normalize(text: string): string {
    return text.replace(/\{RS\}/g, RS).replace(/\{GS\}/g, GS).replace(/\{EOT\}/g, EOT);
}

/**
 * ISO 15434 message with ANSI MH10.8.2 data identifiers: "[)>" RS "06" GS field GS field ... RS EOT.
 * DigiKey: P customer PN, 30P DigiKey PN, 1P manufacturer PN, Q quantity, 9D date code,
 * 1T lot, 4L country, K PO, 1K sales order, 10K invoice, 12Z/13Z internal ids.
 * Mouser: K order, 14K line, 1P manufacturer PN, Q quantity, 11K invoice, 4L country, 1V manufacturer.
 */
export function parseIso15434(text: string): Parsed | null {
    let body = normalize(text);
    if (body.startsWith("[)>")) {
        body = body.slice(3);
        if (body.startsWith(RS)) {
            body = body.slice(1);
        }
        const env = /^\d\d(\x1d|$)/.exec(body);
        if (!env) {
            return null;
        }
        body = body.slice(env[0].length);
    } else if (!body.includes(GS)) {
        return null;
    }
    body = body.replace(/[\x1e\x04\r\n]+$/, "");
    const fields: Record<string, string> = {};
    for (const part of body.split(GS)) {
        if (!part) {
            continue;
        }
        const m = /^(\d{0,2}[A-Z])([\s\S]*)$/.exec(part);
        if (!m) {
            return null;
        }
        if (!(m[1] in fields)) {
            fields[m[1]] = m[2].trim();
        }
    }
    if (!Object.keys(fields).length) {
        return null;
    }
    const digikey = "30P" in fields || "12Z" in fields || "13Z" in fields || /-ND$/i.test(fields.P ?? "");
    const mouser = !digikey && ("1V" in fields || "14K" in fields);
    const p = empty(digikey ? "digikey" : mouser ? "mouser" : "iso15434", text);
    p.fields = fields;
    p.mpn = fields["1P"] ?? "";
    p.vendorPn = fields["30P"] ?? fields.P ?? "";
    p.qty = num(fields.Q);
    p.dateCode = fields["9D"] ?? "";
    p.lot = fields["1T"] ?? "";
    p.country = fields["4L"] ?? "";
    p.manufacturer = fields["1V"] ?? "";
    if (fields["30P"] && fields.P && fields.P !== fields["30P"]) {
        p.notes = `Customer PN ${fields.P}`;
    }
    return p;
}

/** LCSC bag QR: "{pbn:PICK...,on:...,pc:C14663,pm:STM32F103C8T6,qty:10,...}". */
export function parseLcsc(text: string): Parsed | null {
    const t = text.trim();
    if (!t.startsWith("{") || !t.endsWith("}") || t.includes('"')) {
        return null;
    }
    const fields: Record<string, string> = {};
    for (const part of t.slice(1, -1).split(",")) {
        const i = part.indexOf(":");
        if (i < 1) {
            return null;
        }
        fields[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    if (!("pc" in fields) && !("pm" in fields)) {
        return null;
    }
    const p = empty("lcsc", text);
    p.fields = fields;
    p.mpn = fields.pm ?? "";
    p.vendorPn = fields.pc ?? "";
    p.qty = num(fields.qty);
    return p;
}

export const TYPES = ["resistor", "capacitor", "inductor", "diode", "led", "transistor", "mcu", "ic",
    "connector", "switch", "crystal", "module", "other"];

// Common part number families; a convenience, not a classifier. The type field stays editable and
// the app learns the user's own choices per family (see familyKey).
const TYPE_RULES: [RegExp, string][] = [
    [/WROOM|WROVER|MINI-1|NINA-|RAK\d|^E22-|^E32-|^RFM9|^RFM6|^NEO-M|^SAM-M|^ATGM|^HC-0[56]|^HM-1/, "module"],
    [/^(ATMEGA|ATTINY|ATXMEGA|ATSAM|STM32|STM8|ESP32|ESP8266|RP2040|RP2350|NRF5\d|NRF9|SAM[DCEL]\d|PIC\d|DSPIC|LPC\d|EFM32|EFR32|EFM8|MSP430|MSPM0|CH32|CH5[5789]|CC13|CC26|CY8C|MK\d\d|MIMX|GD32|HC32|N76|XMC|TMS320|TM4C|MAX32|RA[246]M|RL78|R7F|S32K|BL6|BL7|W80|W60)/, "mcu"],
    [/^(RC\d|RT\d|RL\d|AC\d|CRCW|CRGCQ|ERJ|ERA|RMCF|RMCP|RNCP|RNCF|RK73|MCR\d|WR\d|TNPW|RCS|RN73|SG73|ESR|CPF|MFR|PTF|RLR|RWR|RCWE|CSR|LVK|WSL|CRA\d|CAY|EXB|YC1|3386|3296|3362|3266|3006|PV36|PVG|RV09|TC33|RK097|RR\d|KTR|MCT|CMF|RNF|MBB|SFR|MOR|ROX)/, "resistor"],
    [/^(CL\d|GRM|GCM|GJM|GRT|GCJ|GQM|GRJ|C0402|C0603|C0805|C1206|C1210|C1812|C2220|CC0|CC1|CGA|CNA|CGJ|EMK|TMK|UMK|JMK|LMK|GMK|AMK|HMK|KGM|KTS|KCM|TPS[A-Z]|T49\d|T52\d|TAJ|TCJ|TLJ|TPM|UUD|UWT|UCL|UVR|UVZ|UPW|UVK|UHE|UKL|URS|EEE|EEU|EEH|ECA|ECE|EKMG|EKZE|EKY|ESK|ELV|ESH|ESX|ESY|ESM|EMV|EMZ|RVT|RVF|CKG|VJ\d|0402[BJKYZ]|0603[BJKYZ]|0805[BJKYZ]|1206[BJKYZ]|FG\d|FK\d|FA\d|ECQ|ECW|B32|MKP|MKS|R82|R46|R75|PHE)/, "capacitor"],
    [/^(LQ[GHMW]|NLV|NLC|SRN|SRR|SRP|SRU|SRF|SDR|CDRH|CDRR|VLS|VLC|VLF|MLF|MLZ|MLP|BLM|MMZ|DLW|NFM|HI0|PBY|744\d|LPS|LPD|XAL|XFL|XGL|DO\d|MSS|IHLP|IHLM|SPM|CKP|DFE|FDSD|TYS|TYA|ETQ|ELL|ASPI|AIS|MGV|RLB|LBC|LBR|BMB|ACM|DLP|FBMH|MPZ|HZ\d|NFE|NFZ)/, "inductor"],
    [/^(LTST|LTL|SML|XL[A-Z]|APT|APHHS|QTLP|KPT|19-|150\d\d|156|HSM[A-Z]|L[BGSYW][A-Z] ?\d|LTW|LTE|LTPL|CLM|CLV|XP[A-Z]|XQ|XHP|LUW|LCW|LRW|LXML|VLM|SSL-|WP\d|L-\d|EL\d|OVS|OVL|LNJ|SLR|SFH|TLG|TLR|TLS|TLY|TLO|VSMY|VSLY|TSAL|TSHG|TSUS|LD271|QED|HLMP)/, "led"],
    [/^(1N\d|BAT\d|BAV\d|BAS\d|BAW|BAR\d|SS1|SS2|SS3|SS5|SMAJ|SMBJ|SMCJ|SMF\d|PESD|ESD\d|MBR|SB\d|US1|US2|RS1|RS2|MMSZ|BZT|BZX|TPD\d|SK\d|SR\d|DFLS|DFLT|B5819|B5817|B340|B140|CDBU|PMEG|NSR|RB\d\d\d|MURS|UF\d|ES[123]|1SS|SDM|STPS|MMBD|PDZ|SMLVT|SRV05|USBLC|PRTR|IP4220|DESD|AZ5|ZMM|BZV|LL4|GS1)/, "diode"],
    [/^(2N\d|2S[ABCDJK]|BC\d\d\d|BCX|BCW|BCP|BSS\d|BSH|BSP|BSR|MMBT|MMBF|DMG|DMN|DMP|DMT|DT[ABCD]\d|AO\d|AON|AOD|AOZ|IRF|IRL|SI\d\d\d\d|SIS|SIR|SIA|FDN|FDV|FDS|FDC|FDMS|NTR|NTD|NTS|NDS|NDT|PMV|PMBT|PMF|PBSS|RSD|RSQ|RQ3|NX\d|SSM3|SSM6|ZXM|ZXT|ZVN|ZVP|ST[DPBFWNLS]\d|PSMN|BUK|FQ[PND]|FD[PB]|IP[DBPIW]|CSD\d|EPC\d|TIP\d|MJE|MJD|MJL|BD\d\d\d|BDX|BU\d|KS[PABCDT]|KT[ACD]|MPSA|PZT|FZT|ZTX|FMMT|BFR|BFP|BFU|BFT|BF\d\d\d|NSS|NSV|S8050|S8550|SS8050|SS8550|S901[2-8])/, "transistor"],
    [/^(S\dB-|B\dB-|PH[RP]|XH[RP]|ZH[RP]|GH[RP]|SH[RP]|SM\d\dB|BM\d\dB|USB4|UJ2|UJC|GCT|TSW-|SSW-|PPTC|PPPC|PRPC|FTS|FTSH|SSQ|HTST|TSM-|SLW|BCS|DF1|DF3|DF13|DF52|DF37|FH12|FH19|FH28|FH34|FH35|OSTT|OSTE|TB0|TBP|ED\d|RJ45|RJ11|SMA-|BNC|MCX|MMCX|U\.FL|IPEX|PJ-|PJ3|SJ1|SJ-|DC-|DCJ|KLDX|PV\d|RJ-|DB9|DB15|DB25|DE9|HDMI|IDC|FFC|FPC)/, "connector"],
    [/^(B3F|B3S|B3U|B3W|B3SL|KSC|KSA|KSE|KSL|KMR|KMS|KMT|KXT|PTS|TS-|TL3|TL1|TL6|TL59|EVQ|EVP|EVK|SKRK|SKQG|SKHH|SKHU|SKRP|SKRR|SKSC|1825|1437|FSM|JS\d|JSS|ATE|MS-|MSS|MHS|MFS|MHP|ESE|EG\d|SLS|CUS|CAS|CHS|DHN|DSS|KAG|KAL|KAN|KEG|KEM|KEN|KEW|DIP|DP\d|DS0[1-4]|PEC|EC1[12]|EC16|EN1[12]|RKJ|PTV|PTD|PDB|RDC|RVQ|PRS|RRS|SRBM|MSK|8LS|TSS)/, "switch"],
    [/^(ABM|ABLS|ABL|ABS\d|ASV|ASE|ASFL|ASD|ASCO|ASTM|ECS-|ECS\d|FA-|FC-|NX\d|CSTCE|CSTNE|CSTLS|CSTCR|XRCGB|XRCHA|XRCMD|SIT\d|SG-|SG\d|DSC|DSA|DSO|TXC|7[ABMV]-|8Z|9[BC]-|CX\d|MC-\d|FCX|TSX|FC135|CM\d|ECX|HC49|HC-49|32\.768|AB26|AB38|AB08)/, "crystal"],
    [/^(LM\d|LMV|LMC|LMH|LMP|LMR|LMZ|TL0|TL1|TL4|TL5|TL7|TLC|TLV|TLE|NE5|SE5|OPA|OP\d|AD\d\d\d|AD8|ADA|ADM|ADP|ADG|ADS|ADC|DAC|MCP\d|MIC\d|MAX\d|LT\d\d\d\d|LTC|LTM|TPS\d|TXS|TXB|SN\d|74[A-Z]+\d|CD4|CD74|MC74|MC14|MC33|MC34|NC[PVS]\d|AP\d\d\d\d|ME6|XC6|XC9|RT9|SY8|MP[1268]|MPM|AMS1|HT7|HT1|LD1|LDL|LP29|LP38|LP59|UA7|L78|L79|MC78|MC79|KA78|AZ1|AZ2|RT8|BQ\d|TP4056|TP5000|IP5|IP2|ETA|SC8|SGM|GS\d\d\d\d|INA\d|ACS7|ACS3|TMP\d|DS18|DS3231|DS1|DS2|PCF\d|PCA\d|TCA\d|SHT|BME|BMP|BMI|BNO|MPU|ICM|LSM|LIS|ADXL|HDC|HTU|SI7|AHT|SGP|CCS8|VL53|VL6|APDS|TSL|BH17|VEML|OPT3|SP3|FT23|FT22|CP210|CH34|CH9102|PL2303|MCP2|TJA1|SN65|ISO1|ADUM|SI86|W25Q|W25N|MX25|AT25|AT24|24LC|24AA|25LC|93C|MT25|S25FL|IS25|GD25|AT45|AS4C|IS42|IS61|CY62|23LC|FM24|FM25|MB85|CAT24|CAT25|M24|M95|TLP\d|PC817|PC8|EL817|LTV|MOC|6N1|HCPL|ACPL|VO\d|4N\d|H11|UCC|IR21|IR2|IRS2|FAN7|TC44|IXD|UC38|UC28|DRV\d|TMC\d|A49|A39|A47|L29|TB6|STSPIN|BTS|BTN|VNH|ULN2|TPIC|MAX7219|HT16|TM16|WS28|SK68|APA10|TLC59|IS31|LP55|AL8|PT4|AP5|ATECC|ATSHA|SE05|DS28|ILI9|ST77|SSD1|SH11|UC17|HX8|GC9|NV3|XPT2|FT6|GT9|CST8|STMPE|TSC2|WM8|PCM\d|CS4[23]|ES8|NAU8|MAX98|TPA\d|PAM8|TDA\d|TA20|NJM|NJU|NJW|UPC|BA\d\d\d\d|TEA|THS|LF3|LF4|ICM75|HEF4|MM74|DM74|SN54|PI\d|NL17|NLU|NLX|LSF|DG4|TMUX|ISL|HIP|EL\d\d\d\d|ADR|REF\d|TL43|TLV43|MIC5|MIC29|TC12|TC10|SPX|L4|L5|L6|L7|L9|LDF|LDK|LDQ|STLQ|STM1|STM6|STM7|STM9)/, "ic"],
];

export function guessType(mpn: string): string {
    const m = mpn.trim().toUpperCase();
    if (!m) {
        return "";
    }
    for (const [re, type] of TYPE_RULES) {
        if (re.test(m)) {
            return type;
        }
    }
    return "";
}

/** Part number family used to remember the user's type choices: leading letters plus one digit. */
export function familyKey(mpn: string): string {
    const m = mpn.trim().toUpperCase();
    const letters = /^[A-Z]+\d?/.exec(m);
    if (letters && letters[0].length > 1) {
        return letters[0];
    }
    return m.replace(/[^A-Z0-9]/g, "").slice(0, 3);
}
