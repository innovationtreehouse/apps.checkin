/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs')
const path = require('node:path')
const { RACING_SUITE } = require('./racingSuites')

const APP = path.resolve(__dirname, '..')

function integrationSuites() {
    return fs.readdirSync(APP, { recursive: true })
        .filter((f) => /\.integration\.test\.[jt]sx?$/.test(f) && !f.split(path.sep).includes('node_modules'))
}

/** The argument text of the call whose open paren is at `open`. */
function callArgument(source, open) {
    let depth = 0
    for (let i = open; i < source.length; i++) {
        if (source[i] === '(') depth++
        else if (source[i] === ')' && --depth === 0) return source.slice(open + 1, i)
    }
    return source.slice(open + 1)
}

/** The top-level comma-separated parts of `text`. */
function topLevelParts(text) {
    const parts = []
    let depth = 0
    let start = 0
    for (let i = 0; i < text.length; i++) {
        if ('([{'.includes(text[i])) depth++
        else if (')]}'.includes(text[i])) depth--
        else if (text[i] === ',' && depth === 0) {
            parts.push(text.slice(start, i))
            start = i + 1
        }
    }
    return [...parts, text.slice(start)].map((p) => p.trim()).filter(Boolean)
}

/** One plain model call or response-body read, which needs no second connection to be right. */
const isPlain = (expr) => /^(await\s+)?(prisma\.[a-z]\w*\.\w+\(|[\w.[\]]+\.json\(\)$)/.test(expr.trim())

/** True when every promise a Promise.all argument starts is a plain model call or body read. */
function startsOnlyPlainWork(arg) {
    const text = arg.trim().replace(/,$/, '')
    if (/^tasks\.map\(/.test(text)) return true // the runPaced mock
    if (text.startsWith('[') && text.endsWith(']')) return topLevelParts(text.slice(1, -1)).every(isPlain)
    const mapped = /^[\s\S]*?\.map\(\s*(async\s*)?(\([^)]*\)|\w+)\s*=>\s*([\s\S]*)\)$/.exec(text)
    return mapped !== null && isPlain(mapped[3])
}

/**
 * Lines that run app work at once: a Promise.all/allSettled that starts anything
 * but plain model calls or body reads, a transaction left open while the test does
 * something else, or a transaction whose callback waits while other work runs.
 */
function concurrentWork(source) {
    const found = []
    const lineOf = (i) => source.slice(0, i).split('\n').length
    for (const m of source.matchAll(/Promise\.(all|allSettled)\(/g)) {
        if (!startsOnlyPlainWork(callArgument(source, m.index + m[0].length - 1))) found.push(lineOf(m.index))
    }
    for (const m of source.matchAll(/prisma\.\$transaction\(/g)) {
        const held = /(const|let)\s+\w+\s*=\s*$/.test(source.slice(Math.max(0, m.index - 40), m.index))
        const waits = /setTimeout|new Promise|await gate\b/.test(callArgument(source, m.index + m[0].length - 1))
        if (held || waits) found.push(lineOf(m.index))
    }
    return found
}

describe('racing integration suites', () => {
    it('get a pool of 2, so their transactions contend on locks instead of taking turns on one connection', () => {
        const unpooled = integrationSuites()
            .filter((f) => !RACING_SUITE.test(f))
            .flatMap((f) => concurrentWork(fs.readFileSync(path.join(APP, f), 'utf8')).map((line) => `${f}:${line}`))
        expect(unpooled).toEqual([])
    })

    it('flags work run at once, and passes fixtures built at once', () => {
        expect(concurrentWork('await Promise.all([withdraw(a), withdraw(a)]);')).toEqual([1])
        expect(concurrentWork('\nconst held = prisma.$transaction(async (tx) => { await gate; });')).toEqual([2])
        expect(concurrentWork('await Promise.all([prisma.person.create({ data: f(1) }), prisma.person.create({ data: f(2) })]);')).toEqual([])
        expect(concurrentWork('const [a, b] = await Promise.all([r1.json(), r2.json()]);')).toEqual([])
        expect(concurrentWork("await Promise.all(['a', 'b'].map((e) => prisma.person.create({ data: { e } })));")).toEqual([])
        expect(concurrentWork('await Promise.all([withdraw(a), prisma.person.findMany()]);')).toEqual([1])
        expect(concurrentWork('await prisma.$transaction(async (tx) => {\n  run = certify(p);\n  await new Promise((r) => setTimeout(r, 500));\n});')).toEqual([1])
        expect(concurrentWork('await prisma.$transaction(async (tx) => { await tx.person.update(u); });')).toEqual([])
    })
})
