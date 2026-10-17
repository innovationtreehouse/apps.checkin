/** A name write that can never blank a Person: a trimmed non-empty string, or undefined
 *  (meaning "leave the stored name alone"). */
export const nameWrite = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;

/** True when `v` is a well-formed nickname write: a string, `null` to clear the
 *  nickname, or `undefined` to leave it alone. Routes 400 anything else — mapping a
 *  malformed value to null would let a buggy caller silently erase a stored nickname. */
export const isNicknameWrite = (v: unknown): v is string | null | undefined =>
    v === undefined || v === null || typeof v === "string";

/** A nickname write: a trimmed non-empty string, `null` to clear it, or `undefined`
 *  (meaning "leave the stored nickname alone"). Unlike a name, a nickname is optional,
 *  so an explicit blank clears it rather than being rejected. */
export const nicknameWrite = (v: string | null | undefined): string | null | undefined =>
    typeof v === "string" ? v.trim() || null : v;

/** A stored name split into the parts that labels, sort keys and household names are built from. */
export interface ParsedName {
    /** What the person is called when no nickname is set; "" for a blank name. */
    given: string;
    /** null when there is no surname to show: a one-word name, or one written in Chinese,
     *  Japanese or Korean script, which is always shown whole. */
    surname: Surname | null;
    /** A generational or professional suffix ("Jr.", "III", "PhD"), or "". */
    suffix: string;
}

/** A surname as the particles kept whole when it is shortened ("van der ", "al-", "d'") and the
 *  core that is shortened ("Graaf"). */
export interface Surname {
    particles: string;
    core: string;
}

// Words that belong to the surname after them. They print whole ahead of the shortened core:
// "Vincent van G.", "Máire Ní B.", "Anwar bin I.".
const PARTICLES = new Set([
    // Dutch, Flemish, German, Scandinavian
    "van", "vande", "vanden", "vander", "von", "vom", "zu", "zum", "zur", "und", "de", "der", "den",
    "het", "'t", "ter", "ten", "te", "op", "in", "uit", "aan", "af", "av",
    // Romance languages, Filipino
    "da", "das", "do", "dos", "di", "du", "des", "del", "dela", "delos", "delas", "della", "delle",
    "dello", "degli", "dei", "dal", "dalla", "la", "le", "lo", "las", "los", "les",
    "st", "ste", "saint", "sainte", "san", "santa", "santo",
    // Irish, Scottish, Welsh
    "mac", "mc", "ó", "ní", "nic", "uí", "ua", "mhic", "giolla", "ap", "ab", "ferch", "verch",
    // Arabic, Hebrew, Malay; Malaysian and Singaporean "son of" / "daughter of"
    "al", "el", "ul", "bin", "binti", "binte", "bint", "ibn", "ben", "bat", "ould", "a/l", "a/p", "s/o", "d/o",
]);

// Given-name elements that never stand alone, so they bind to the word after them:
// "Abdul Rahman", "Abu Bakr".
const BOUND_GIVEN = new Set(["abd", "abdul", "abdel", "abdal", "abdol", "abdur", "abdus", "abu", "abou", "umm"]);

// Words that are particles elsewhere but open a two-word given name: "La Toya Jackson",
// "Van Dyke Parks", "St John Philby", "Te Ururoa Flavell", "El Hadji Diouf". Alone before a
// surname they are the given name itself ("Von Miller").
const GIVEN_OPENERS = new Set(["la", "le", "de", "da", "du", "di", "del", "von", "van", "st", "te", "ja", "el"]);

// Abbreviations of Muhammad and Mosammat written before the name a person is called by:
// "Md. Rahim Uddin".
const LEADING_ABBREVIATIONS = new Set(["md", "mohd", "muhd", "mst"]);

// Titles written before a name: "Dr.", and "Syed", "Sheikh", "Haji", "Datuk", "Chief", "Alhaji".
const HONORIFICS = new Set([
    "mr", "mrs", "ms", "mx", "miss", "dr", "prof", "rev",
    "syed", "sayed", "sayyid", "seyed", "sheikh", "shaikh", "mir", "haj", "haji", "hajji", "hajah", "hajjah",
    "hj", "hjh", "mashhadi", "tun", "datuk", "dato", "dato'", "datin", "seri", "ustaz", "ustazah",
    "chief", "alhaji", "alhaja",
]);

// Records stand these in for a missing part: "first name unknown", "no middle name".
const PLACEHOLDERS = new Set(["fnu", "lnu", "nfn", "nln", "nmn", "nmi"]);

const SUFFIXES = new Set([
    "jr", "jnr", "sr", "snr", "junior", "senior", "2nd", "3rd", "4th", "5th",
    "phd", "md", "dds", "dmd", "dvm", "jd", "esq", "rn", "cpa", "mba",
]);
// Portuguese generational suffixes, which are also surnames in their own right: "Maria Neto".
const SURNAME_SUFFIXES = new Set(["júnior", "filho", "filha", "neto", "netto", "neta", "sobrinho", "sobrinha"]);
// Upper case only: "Vi" is a given name.
const ROMAN_NUMERAL = /^(?:II|III|IV|VI|VII|VIII|IX)$/;

// Joins two surnames into one: "Ortega y Gasset", "Silva e Souza", "Puig i Cadafalch".
const CONNECTORS = new Set(["y", "e", "i"]);

// Persian surname endings sometimes typed as a word of their own: "Hassan Zadeh".
const SURNAME_ENDINGS = new Set(["zadeh", "zade", "pour", "nejad", "nezhad"]);

// The "Van" before one of these is the Vietnamese middle name Văn, not the Dutch particle.
const VIETNAMESE_SURNAMES = new Set([
    "nguyen", "tran", "le", "pham", "hoang", "huynh", "phan", "vu", "vo", "dang", "bui", "do", "ho",
    "ngo", "duong", "ly", "truong", "dinh", "doan", "lam", "luong", "mai", "trinh", "ta", "cao", "luu", "ha",
]);
// Vietnamese middle names, Văn and Thị, which never open a name written given name first.
const VIETNAMESE_MIDDLE = new Set(["van", "thi"]);

// The Arabic article, including its assimilated forms: "al-Farsi", "El-Sayed", "ad-Din".
const ARTICLE_PREFIX = /^(?:al|el|ad|adh|an|ar|as|ash|at|ath|az)[-‐](?=\p{L})/iu;
// The article run into a capital: "ElBaradei". Case-sensitive, so "Alvarez" and "Ellis" stay whole.
const CAPITALISED_ARTICLE = /^(?:Al|El)(?=\p{Lu})/u;
// A lower-case start before the first capital: "d'Alembert", "dell'Acqua", and the Irish
// "hÓgáin" and "tSaoi", where the capital begins the name. "D'Angelo" and "McDonald" are one word.
const LOWERCASE_PREFIX = /^\p{Ll}+['’]?(?=\p{Lu})/u;

// Scripts that write a name whole, family name first, with no initials to take.
const WHOLE_NAME_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN = /\p{Script=Latin}/u;
// Scripts that shorten a surname to its first letter. A surname in any other shows whole.
const INITIAL_SCRIPT = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Hebrew}]/u;
// Hebrew marks a shortened word with a geresh, not a period.
const HEBREW = /\p{Script=Hebrew}/u;
// A letter that can be capitalised or stand as an initial: not a modifier such as the ʻokina.
const BASE_LETTER = /[\p{Lu}\p{Ll}\p{Lt}\p{Lo}]/u;

const FOLDED: Record<string, string> = { "đ": "d", "ð": "d", "ł": "l", "ø": "o", "æ": "ae", "œ": "oe", "ß": "ss", "þ": "th", "ı": "i" };

/** A name reduced for comparison: case, accents and a few letter variants ignored. */
function foldName(text: string): string {
    return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[đðłøæœßþı]/g, (ch) => FOLDED[ch]);
}

const wordKey = (word: string): string => word.toLowerCase().replace(/[’‘ʼ]/g, "'").replace(/\./g, "");
const words = (text: string): string[] => text.split(/\s+/).filter((w) => w && !PLACEHOLDERS.has(wordKey(w)));
const isParticle = (word: string): boolean => PARTICLES.has(wordKey(word)) || BOUND_GIVEN.has(wordKey(word));
const isSuffix = (word: string): boolean => SUFFIXES.has(wordKey(word)) || ROMAN_NUMERAL.test(word.replace(/\.$/, ""));
const isSuffixSegment = (segment: string): boolean => words(segment).length > 0 && words(segment).every(isSuffix);
const isInitial = (word: string): boolean => /^\p{L}\.?$/u.test(word) && !PARTICLES.has(wordKey(word));
const isCapitalised = (word: string): boolean => /^\p{Lu}/u.test(word);
const isAllCaps = (word: string): boolean => word === word.toUpperCase() && word !== word.toLowerCase();
const letterCount = (text: string): number => [...text].filter((ch) => BASE_LETTER.test(ch)).length;

// 'Paul "Bear" Bryant' goes by the quoted name. A bracketed note ("Jane Smith (née Doe)") is not
// part of the name at all.
function withoutAsides(raw: string): { text: string; quoted: string } {
    let quoted = "";
    const aside = (inner: string) => {
        if (!quoted) quoted = inner.trim();
        return " ";
    };
    const unquoted = raw
        .replace(/["“„«]([^"“”„«»]+)["”»]/g, (_, inner: string) => aside(inner))
        .replace(/(^|\s)['‘]([^\s'‘’]+)['’](?=\s|$)/g, (_, lead: string, inner: string) => lead + aside(inner))
        .replace(/["“”„«»]/g, " ");
    const kept = unquoted.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").trim() || unquoted.replace(/[()[\]]/g, " ");
    const text = kept.replace(/\s+/g, " ").trim();
    // A name quoted whole is not a nickname.
    return text ? { text, quoted } : { text: quoted, quoted: "" };
}

/** `ws` less its trailing suffix words, which move to the front of `suffixes`. At least one word
 *  stays, and two before a suffix that can also be a surname. */
function withoutSuffixes(ws: string[], suffixes: string[]): string[] {
    const kept = [...ws];
    for (;;) {
        const last = kept[kept.length - 1] ?? "";
        if (!(kept.length > 1 && isSuffix(last)) && !(kept.length > 2 && SURNAME_SUFFIXES.has(wordKey(last)))) return kept;
        suffixes.unshift(kept.pop() as string);
    }
}

// "Nguyễn Văn An" is written family name first, and its bearer is called by the last word.
function vietnameseOrder(ws: string[]): string[] {
    if (ws.length < 3 || !VIETNAMESE_SURNAMES.has(foldName(ws[0])) || !VIETNAMESE_MIDDLE.has(foldName(ws[1]))) return ws;
    return [ws[ws.length - 1], ...ws.slice(1, -1), ws[0]];
}

// A family name written first in capitals, as passports and conference badges do: "WANG Wei".
// Two capitals are a given name ("JJ Smith"), not a family name.
function familyFirst(ws: string[]): string[] {
    let count = 0;
    while (count < ws.length && isAllCaps(ws[count])) count++;
    if (count === 0 || count === ws.length || letterCount(ws.slice(0, count).join("")) < 3) return ws;
    return [...ws.slice(count), ...ws.slice(0, count)];
}

/** How many words after `ws[start]` belong to the same given name. */
function boundWords(ws: string[], start: number, keep: number): number {
    const first = wordKey(ws[start] ?? "");
    if (BOUND_GIVEN.has(first)) {
        let next = start + 1;
        while (next < ws.length - 1 && PARTICLES.has(wordKey(ws[next]))) next++;
        return next < ws.length ? next - start : 0;
    }
    return GIVEN_OPENERS.has(first) && ws.length - start > keep ? 1 : 0;
}

/** The name a person is called by and the words after it. Skipping or binding words must leave
 *  `keep` of them: two when the surname is among them, one when it is not. */
function splitGiven(ws: string[], keep: number): { given: string; rest: string[] } {
    let start = 0;
    while (ws.length - start > keep && HONORIFICS.has(wordKey(ws[start]))) start++;
    while (ws.length - start > 1 && LEADING_ABBREVIATIONS.has(wordKey(ws[start]))) start++;
    let end = start;
    while (end < ws.length && isInitial(ws[end])) end++;
    // A Tamil name puts the father's initial first: "R. Krishnan" is called Krishnan R.
    if (keep === 2 && end - start === 1 && ws.length === end + 1) return { given: ws[end], rest: ws.slice(start, end) };
    // "J. Edgar Hoover" is called Edgar; "T. J. Smith" is called T. J.
    if (end > start && ws.length - end >= keep) start = end;
    if (end - start < 2) end = start + 1 + boundWords(ws, start, keep);
    return { given: ws.slice(start, end).join(" "), rest: ws.slice(end) };
}

function surnameFrom(particleWords: string[], core: string): Surname | null {
    const attached = (ARTICLE_PREFIX.exec(core) ?? CAPITALISED_ARTICLE.exec(core) ?? LOWERCASE_PREFIX.exec(core))?.[0] ?? "";
    const rest = core.slice(attached.length);
    if (!letterCount(rest)) return null;
    return { particles: particleWords.map((w) => `${w} `).join("") + attached, core: rest };
}

/** The surname ending `ws`: its last word, joined across connectors, with the particles before it. */
function trailingSurname(ws: string[]): Surname | null {
    if (!ws.length) return null;
    let coreStart = ws.length - 1;
    if (coreStart >= 1 && SURNAME_ENDINGS.has(wordKey(ws[coreStart]))) coreStart--;
    while (coreStart >= 2 && CONNECTORS.has(ws[coreStart - 1]) && isCapitalised(ws[coreStart - 2]) && isCapitalised(ws[coreStart])) {
        coreStart -= 2;
    }
    let particleStart = coreStart;
    if (!VIETNAMESE_SURNAMES.has(foldName(ws[ws.length - 1]))) {
        while (particleStart > 0 && isParticle(ws[particleStart - 1])) particleStart--;
    }
    return surnameFrom(ws.slice(particleStart, coreStart), ws.slice(coreStart).join(" "));
}

/** A surname written on its own, as before the comma in "García Márquez, Gabriel": leading
 *  particles, then everything else as the core. */
function wholeSurname(ws: string[]): Surname | null {
    let coreStart = 0;
    while (coreStart < ws.length - 1 && isParticle(ws[coreStart])) coreStart++;
    return surnameFrom(ws.slice(0, coreStart), ws.slice(coreStart).join(" "));
}

function parseWords(text: string): ParsedName {
    const suffixes: string[] = [];
    const segments = text.split(",").map((s) => s.trim()).filter(Boolean);
    while (segments.length > 1 && isSuffixSegment(segments[segments.length - 1])) suffixes.unshift(segments.pop() as string);
    if (segments.length > 1) {
        const surname = wholeSurname(withoutSuffixes(words(segments[0]), suffixes));
        const { given } = splitGiven(withoutSuffixes(words(segments[1]), suffixes), 1);
        return { given, surname, suffix: suffixes.join(" ") };
    }
    const ordered = familyFirst(vietnameseOrder(withoutSuffixes(words(segments[0] ?? ""), suffixes)));
    const { given, rest } = splitGiven(ordered, 2);
    return { given, surname: trailingSurname(rest), suffix: suffixes.join(" ") };
}

/**
 * The one parser for a person's stored full name. Reads "First Middle Last", "Last, First",
 * suffixes with or without a comma, a quoted nickname, and a family name written first in
 * capitals or in Vietnamese order.
 */
export function parsePersonName(full: string | null | undefined): ParsedName {
    const { text, quoted } = withoutAsides((full ?? "").normalize("NFC"));
    if (WHOLE_NAME_SCRIPT.test(text) && !LATIN.test(text)) return { given: text, surname: null, suffix: "" };
    const { given, surname, suffix } = parseWords(text);
    if (quoted) return { given: quoted, surname, suffix };
    // With no given name recorded ("Smith, FNU"), the surname is the whole name.
    if (!given && surname) return { given: surname.particles + surname.core, surname: null, suffix };
    return { given, surname, suffix };
}

/** The name someone goes by: their nickname, else the given name in `name`. */
export function goesBy(person: { name: string | null; nickname?: string | null }): string {
    return person.nickname?.trim() || parsePersonName(person.name).given;
}

/** The surname a household is named after, as it stands alone ("Van Gogh"); a name with no
 *  surname stands for itself. */
export function familyName(full: string | null | undefined): string {
    const { given, surname } = parsePersonName(full);
    // A father's initial ("R. Krishnan") is not a family name.
    const family = surname && !isInitial(surname.core) ? surname.particles + surname.core : given;
    // An Irish initial mutation stays lower case: "tSaoi", "hÓgáin".
    return /^\p{Ll}+\p{Lu}/u.test(family) ? family : family.replace(BASE_LETTER, (ch) => ch.toUpperCase());
}

/** The first `count` letters of `word`, with the accents and inner punctuation among them
 *  ("O'B", "ʻI"), and whether that is all of it. */
function leadingLetters(word: string, count: number): { text: string; whole: boolean } {
    let text = "";
    let pending = "";
    let taken = 0;
    for (const ch of word) {
        if (BASE_LETTER.test(ch)) {
            if (taken === count) return { text, whole: false };
            text += pending + ch;
            pending = "";
            taken++;
        } else if (/\p{M}/u.test(ch) && !pending) {
            text += ch;
        } else {
            pending += ch;
        }
    }
    return { text, whole: true };
}

/** `surname` cut to `count` letters of its core, particles kept: "van der S.", "O'B.", "Li". */
function shorten({ particles, core }: Surname, count: number): { text: string; whole: boolean } {
    const initial = [...core].find((ch) => BASE_LETTER.test(ch)) ?? "";
    const { text, whole } = INITIAL_SCRIPT.test(initial) ? leadingLetters(core, count) : { text: core, whole: true };
    const mark = whole ? "" : HEBREW.test(initial) ? "׳" : ".";
    return { text: particles + text.replace(BASE_LETTER, (ch) => ch.toUpperCase()) + mark, whole };
}

// Compares labels as a reader would: case, accents, punctuation and the ʻokina ignored.
const matchKey = (label: string): string =>
    foldName(label).replace(/\p{Lm}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

type Rival = { surname: Surname; suffix: string };

/** The shortest cut of `entry`'s surname that no rival's cut of the same length matches. */
function tellApart(entry: Rival, rivals: Rival[], maxLetters: number): string {
    const whole = (r: Rival) => matchKey(r.surname.particles + r.surname.core);
    for (let count = 1; ; count++) {
        const { text, whole: complete } = shorten(entry.surname, count);
        const clashes = rivals.filter((r) => matchKey(shorten(r.surname, count).text) === matchKey(text));
        if (!clashes.length) return text;
        // More letters never tell "John Smith" from "John Smith Jr."; the suffix does.
        if (clashes.every((r) => whole(r) === whole(entry) && wordKey(r.suffix) !== wordKey(entry.suffix))) {
            return entry.suffix ? `${text} ${entry.suffix}` : text;
        }
        if (complete || count >= maxLetters) return text;
    }
}

/**
 * Labels for people shown together: the name each goes by and, only where two share it, the
 * shortest part of the surname that tells them apart ("Sarah M.", "Sarah Mo.", "Vincent van
 * G."), using at most `maxLetters` letters of it. A suffix is added where only it differs
 * ("John S. Jr."). `fallback` names someone with neither name nor nickname.
 */
export function displayNames<P extends { id: number; name: string | null; nickname?: string | null }>(
    people: readonly P[],
    { maxLetters = Infinity, fallback }: { maxLetters?: number; fallback: (person: P) => string },
): Map<number, string> {
    const groups = new Map<string, { id: number; first: string; surname: Surname | null; suffix: string }[]>();
    for (const person of people) {
        const { given, surname, suffix } = parsePersonName(person.name);
        const entry = { id: person.id, first: person.nickname?.trim() || given || fallback(person), surname, suffix };
        const key = foldName(entry.first);
        const group = groups.get(key);
        if (group) group.push(entry);
        else groups.set(key, [entry]);
    }
    const labels = new Map<number, string>();
    for (const group of groups.values()) {
        for (const entry of group) {
            const { surname, suffix } = entry;
            if (group.length === 1 || !surname) {
                labels.set(entry.id, entry.first);
                continue;
            }
            const rivals = group.flatMap((other) => (other !== entry && other.surname ? [{ surname: other.surname, suffix: other.suffix }] : []));
            labels.set(entry.id, `${entry.first} ${tellApart({ surname, suffix }, rivals, maxLetters)}`);
        }
    }
    return labels;
}
