import {
    nameWrite, nicknameWrite, isNicknameWrite, parsePersonName, goesBy, familyName, displayNames,
} from "@/lib/person/name";

describe("nameWrite", () => {
    it("trims a real name and rejects blank or non-string input", () => {
        expect(nameWrite("  Jane ")).toBe("Jane");
        expect(nameWrite("   ")).toBeUndefined();
        expect(nameWrite(42)).toBeUndefined();
        expect(nameWrite(undefined)).toBeUndefined();
    });
});

describe("nickname writes", () => {
    it("trims a nickname, clears on blank or null, leaves the stored one on undefined", () => {
        expect(nicknameWrite("  Dave ")).toBe("Dave");
        expect(nicknameWrite("   ")).toBeNull();
        expect(nicknameWrite(null)).toBeNull();
        expect(nicknameWrite(undefined)).toBeUndefined();
    });

    // isNicknameWrite is the routes' 400 gate: a buggy caller sending a number or an
    // object must be refused, not treated as a clear that erases the stored nickname.
    it("refuses a malformed write instead of reading it as a clear", () => {
        expect(isNicknameWrite("Dave")).toBe(true);
        expect(isNicknameWrite("")).toBe(true);
        expect(isNicknameWrite(null)).toBe(true);
        expect(isNicknameWrite(undefined)).toBe(true);
        expect(isNicknameWrite(42)).toBe(false);
        expect(isNicknameWrite({})).toBe(false);
        expect(isNicknameWrite(["Dave"])).toBe(false);
    });
});

// [given, particles, core, suffix] — core is "" when the name has no surname.
const parts = (full: string | null) => {
    const { given, surname, suffix } = parsePersonName(full);
    return [given, surname?.particles ?? "", surname?.core ?? "", suffix];
};

describe("parsePersonName", () => {
    it("takes the first word as the given name and the last as the surname", () => {
        expect(parts("Sarah Miller")).toEqual(["Sarah", "", "Miller", ""]);
        expect(parts("John Frank Doe")).toEqual(["John", "", "Doe", ""]);
    });

    it.each([
        ["Maria von Trapp", "Maria", "von ", "Trapp"],
        ["Vincent van Gogh", "Vincent", "van ", "Gogh"],
        ["Anna van der Berg", "Anna", "van der ", "Berg"],
        ["Maria De La Cruz", "Maria", "De La ", "Cruz"],
        ["Juan dela Cruz", "Juan", "dela ", "Cruz"],
        ["Leonardo da Vinci", "Leonardo", "da ", "Vinci"],
        ["Máire Ní Bhriain", "Máire", "Ní ", "Bhriain"],
        ["Rhys ap Gruffydd", "Rhys", "ap ", "Gruffydd"],
        ["Anwar bin Ibrahim", "Anwar", "bin ", "Ibrahim"],
        ["Muthu a/l Rajan", "Muthu", "a/l ", "Rajan"],
        ["Kiri Te Kanawa", "Kiri", "Te ", "Kanawa"],
        ["Mary St. John", "Mary", "St. ", "John"],
        ["Ahmed al Farsi", "Ahmed", "al ", "Farsi"],
        ["Ahmed Al-Farsi", "Ahmed", "Al-", "Farsi"],
        ["Jean d'Alembert", "Jean", "d'", "Alembert"],
        ["Seán Ó hÓgáin", "Seán", "Ó h", "Ógáin"],
        ["Omar ad-Dajani", "Omar", "ad-", "Dajani"],
        ["Mohamed ElBaradei", "Mohamed", "El", "Baradei"],
        ["Siti binte Ahmad", "Siti", "binte ", "Ahmad"],
    ])("keeps the particles of %s with the surname", (full, given, particles, core) => {
        expect(parts(full)).toEqual([given, particles, core, ""]);
    });

    it.each([
        ["Anthony D'Angelo", "D'Angelo"],
        ["Sean O'Brien", "O'Brien"],
        ["John McDonald", "McDonald"],
        ["Maria Alvarez", "Alvarez"],
        ["Tom Ellis", "Ellis"],
    ])("keeps the fused prefix of %s inside the surname", (full, core) => {
        expect(parts(full)[2]).toBe(core);
        expect(parts(full)[1]).toBe("");
    });

    it("joins two surnames across a connector", () => {
        expect(parts("José Ortega y Gasset")).toEqual(["José", "", "Ortega y Gasset", ""]);
        expect(parts("Pere Aragonès i Garcia")).toEqual(["Pere", "", "Aragonès i Garcia", ""]);
    });

    it("joins a Persian surname ending typed as its own word", () => {
        expect(parts("Ali Hassan Zadeh")).toEqual(["Ali", "", "Hassan Zadeh", ""]);
    });

    it("reads Van before a Vietnamese surname as the middle name Văn, not a particle", () => {
        expect(parts("Tuan Van Tran")).toEqual(["Tuan", "", "Tran", ""]);
        expect(parts("Anh Văn Nguyễn")).toEqual(["Anh", "", "Nguyễn", ""]);
    });

    it("reads a Vietnamese name written family name first, calling the person by the last word", () => {
        expect(parts("Nguyễn Văn An")).toEqual(["An", "", "Nguyễn", ""]);
        expect(parts("Tran Thi Mai")).toEqual(["Mai", "", "Tran", ""]);
    });

    it("takes everything before the comma as the surname in 'Last, First'", () => {
        expect(parts("King, Martin Luther")).toEqual(["Martin", "", "King", ""]);
        expect(parts("García Márquez, Gabriel")).toEqual(["Gabriel", "", "García Márquez", ""]);
        expect(parts("De La Cruz, Maria")).toEqual(["Maria", "De La ", "Cruz", ""]);
    });

    it("sets a suffix aside, with or without a comma", () => {
        expect(parts("Martin Luther King Jr.")).toEqual(["Martin", "", "King", "Jr."]);
        expect(parts("Martin Luther King, Jr.")).toEqual(["Martin", "", "King", "Jr."]);
        expect(parts("King, Martin Luther, Jr.")).toEqual(["Martin", "", "King", "Jr."]);
        expect(parts("Henry Ford II")).toEqual(["Henry", "", "Ford", "II"]);
        expect(parts("Jane Smith, PhD")).toEqual(["Jane", "", "Smith", "PhD"]);
        expect(parts("João da Silva Filho")).toEqual(["João", "da ", "Silva", "Filho"]);
    });

    it("keeps a Portuguese suffix that is the only surname there is", () => {
        expect(parts("Maria Neto")).toEqual(["Maria", "", "Neto", ""]);
    });

    it("never reads an English suffix as a surname", () => {
        expect(parts("John Jr.")).toEqual(["John", "", "", "Jr."]);
    });

    it("reads an Irish Ó as a particle, never an initial", () => {
        expect(parts("Seán Ó Briain")).toEqual(["Seán", "Ó ", "Briain", ""]);
    });

    it("reads a mixed-case roman numeral as a name, not a suffix", () => {
        expect(parts("Tuong Vi")).toEqual(["Tuong", "", "Vi", ""]);
    });

    it("skips a title, a Muhammad abbreviation, or a first initial the person does not go by", () => {
        expect(parts("Dr. Jane Smith")).toEqual(["Jane", "", "Smith", ""]);
        expect(parts("Sheikh Hasina Wazed")).toEqual(["Hasina", "", "Wazed", ""]);
        expect(parts("Datuk Seri Anwar Ibrahim")).toEqual(["Anwar", "", "Ibrahim", ""]);
        expect(parts("Md. Rahim Uddin")).toEqual(["Rahim", "", "Uddin", ""]);
        expect(parts("J. Edgar Hoover")).toEqual(["Edgar", "", "Hoover", ""]);
    });

    it("keeps a title that is all there is before the surname", () => {
        expect(parts("Dr. Smith")).toEqual(["Dr.", "", "Smith", ""]);
    });

    it("reads a single initial before one word as a Tamil father's initial", () => {
        expect(parts("R. Krishnan")).toEqual(["Krishnan", "", "R.", ""]);
    });

    it("keeps initials that are the name itself", () => {
        expect(parts("JJ Smith")).toEqual(["JJ", "", "Smith", ""]);
        expect(parts("T.J. Miller")).toEqual(["T.J.", "", "Miller", ""]);
        expect(parts("T. J. Miller")).toEqual(["T. J.", "", "Miller", ""]);
    });

    it("reads a particle-like first word as opening a two-word given name when a surname follows", () => {
        expect(parts("La Toya Jackson")).toEqual(["La Toya", "", "Jackson", ""]);
        expect(parts("Van Dyke Parks")).toEqual(["Van Dyke", "", "Parks", ""]);
        expect(parts("St John Philby")).toEqual(["St John", "", "Philby", ""]);
        expect(parts("Te Ururoa Flavell")).toEqual(["Te Ururoa", "", "Flavell", ""]);
        expect(parts("El Hadji Diouf")).toEqual(["El Hadji", "", "Diouf", ""]);
        expect(parts("Jackson, La Toya")).toEqual(["La Toya", "", "Jackson", ""]);
    });

    it("keeps a particle-like first word as the whole given name when only a surname follows", () => {
        expect(parts("Von Miller")).toEqual(["Von", "", "Miller", ""]);
        expect(parts("Van Morrison")).toEqual(["Van", "", "Morrison", ""]);
    });

    it("binds a given name that never stands alone to the word after it", () => {
        expect(parts("Abdul Rahman Khan")).toEqual(["Abdul Rahman", "", "Khan", ""]);
        expect(parts("Abd al Rahman Khalil")).toEqual(["Abd al Rahman", "", "Khalil", ""]);
        expect(parts("Abu Bakr")).toEqual(["Abu Bakr", "", "", ""]);
    });

    it("reads a leading run of capitals as a family name written first", () => {
        expect(parts("WANG Wei")).toEqual(["Wei", "", "WANG", ""]);
        expect(parts("VAN DER BERG Anna")).toEqual(["Anna", "VAN DER ", "BERG", ""]);
    });

    it("keeps a Chinese, Japanese or Korean name whole", () => {
        expect(parts("王小明")).toEqual(["王小明", "", "", ""]);
        expect(parts("山田 太郎")).toEqual(["山田 太郎", "", "", ""]);
        expect(parts("김민준")).toEqual(["김민준", "", "", ""]);
    });

    it("takes a quoted nickname as the name the person goes by", () => {
        expect(parts('Paul "Bear" Bryant')).toEqual(["Bear", "", "Bryant", ""]);
        expect(parts("Robert 'Bob' Smith")).toEqual(["Bob", "", "Smith", ""]);
        expect(parts('"Jane Smith"')).toEqual(["Jane", "", "Smith", ""]);
    });

    it("drops a bracketed note", () => {
        expect(parts("Jane Smith (née Doe)")).toEqual(["Jane", "", "Smith", ""]);
    });

    it("drops the placeholders records use for a missing part", () => {
        expect(parts("FNU Rahman")).toEqual(["Rahman", "", "", ""]);
        expect(parts("Mohammed LNU")).toEqual(["Mohammed", "", "", ""]);
        expect(parts("Smith, FNU")).toEqual(["Smith", "", "", ""]);
    });

    it("has no surname for a one-word or blank name", () => {
        expect(parts("Cher")).toEqual(["Cher", "", "", ""]);
        expect(parts("   ")).toEqual(["", "", "", ""]);
        expect(parts(null)).toEqual(["", "", "", ""]);
    });
});

describe("goesBy", () => {
    it("is the nickname when there is one, else the parsed given name", () => {
        expect(goesBy({ name: "David Smith", nickname: " Dave " })).toBe("Dave");
        expect(goesBy({ name: "Dr. Jane Smith", nickname: "  " })).toBe("Jane");
        expect(goesBy({ name: "Johnson, Sarah" })).toBe("Sarah");
        expect(goesBy({ name: null })).toBe("");
    });
});

describe("familyName", () => {
    it("is the surname with its particles, capitalised as it stands alone", () => {
        expect(familyName("Vincent van Gogh")).toBe("Van Gogh");
        expect(familyName("Ahmed al-Farsi")).toBe("Al-Farsi");
        expect(familyName("Martin Luther King Jr.")).toBe("King");
    });

    it("falls back to the name itself when there is no surname", () => {
        expect(familyName("Cher")).toBe("Cher");
        expect(familyName("R. Krishnan")).toBe("Krishnan");
        expect(familyName("John Jr.")).toBe("John");
        expect(familyName("王小明")).toBe("王小明");
        expect(familyName("")).toBe("");
    });
});

describe("displayNames", () => {
    const label = (names: (string | null)[], maxLetters?: number) => {
        const map = displayNames(names.map((name, id) => ({ id, name })), { maxLetters, fallback: (p) => `#${p.id}` });
        return names.map((_, id) => map.get(id));
    };

    it("shows the given name alone when no one shares it", () => {
        expect(label(["Maria von Trapp", "Anna Tanaka"])).toEqual(["Maria", "Anna"]);
    });

    it("keeps particles whole and shortens only the core", () => {
        expect(label(["Maria von Trapp", "Maria Tanaka"])).toEqual(["Maria von T.", "Maria T."]);
        expect(label(["Maria De La Cruz", "Maria Diaz"])).toEqual(["Maria De La C.", "Maria D."]);
    });

    it("grows the cut past punctuation instead of ending on it", () => {
        expect(label(["Sean O'Brien", "Sean Olsen"])).toEqual(["Sean O'B.", "Sean Ol."]);
    });

    it("shortens the surname, never the suffix", () => {
        expect(label(["Martin Luther King Jr.", "Martin Scorsese"])).toEqual(["Martin K.", "Martin S."]);
    });

    it("tells a father and son apart by the suffix, since no more of the surname can", () => {
        expect(label(["John Smith", "John Smith Jr."])).toEqual(["John S.", "John S. Jr."]);
        expect(label(["John Smith", "John Smith Jr.", "John Smythe"])).toEqual(["John Smi.", "John Smi. Jr.", "John Smy."]);
    });

    it("never shows a modifier letter such as the ʻokina as an initial on its own", () => {
        expect(label(["Keola ʻIolani", "Keola Kahale"])).toEqual(["Keola ʻI.", "Keola K."]);
    });

    it("prints a surname it reaches the end of without a period", () => {
        expect(label(["Sarah Li", "Sarah Lin"])).toEqual(["Sarah Li", "Sarah Lin"]);
    });

    it("counts first names the same regardless of case or accents", () => {
        expect(label(["José Smith", "jose Jones"])).toEqual(["José S.", "jose J."]);
    });

    it("shows the whole surname in a script that has no initials", () => {
        expect(label(["محمد الأحمد", "محمد السيد"])).toEqual(["محمد الأحمد", "محمد السيد"]);
    });

    it("shortens a Hebrew surname with a geresh", () => {
        expect(label(["דוד כהן", "דוד לוי"])).toEqual(["דוד כ׳", "דוד ל׳"]);
    });

    it("tells two Tamil names apart by the father's initial", () => {
        expect(label(["R. Krishnan", "S. Krishnan"])).toEqual(["Krishnan R", "Krishnan S"]);
    });

    it("stops at maxLetters letters of the surname", () => {
        expect(label(["Sarah Morris", "Sarah Moore"], 2)).toEqual(["Sarah Mo.", "Sarah Mo."]);
        expect(label(["Sarah Morris", "Sarah Moore"])).toEqual(["Sarah Mor.", "Sarah Moo."]);
    });

    it("uses the fallback for someone with neither a name nor a nickname", () => {
        expect(label([null, "Cher"])).toEqual(["#0", "Cher"]);
    });

    it("puts a nickname in place of the given name and tells it apart by the parsed surname", () => {
        const map = displayNames(
            [{ id: 1, name: "Robert von Trapp", nickname: "Bob" }, { id: 2, name: "Bob Tanaka", nickname: null }],
            { fallback: () => "" },
        );
        expect([map.get(1), map.get(2)]).toEqual(["Bob von T.", "Bob T."]);
    });
});
