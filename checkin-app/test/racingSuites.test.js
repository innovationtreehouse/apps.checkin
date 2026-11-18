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

/**
 * Lines that run app work at once: a Promise.all/allSettled over anything but
 * plain model reads and writes (fixtures, response bodies, the runPaced mock), or
 * a transaction left open while the test does something else.
 */
function concurrentWork(source) {
    const found = []
    const lineOf = (i) => source.slice(0, i).split('\n').length
    for (const m of source.matchAll(/Promise\.(all|allSettled)\(/g)) {
        const arg = callArgument(source, m.index + m[0].length - 1)
        if (/prisma\.[a-z]\w*\.|\.json\(\)|tasks\.map/.test(arg)) continue
        found.push(lineOf(m.index))
    }
    for (const m of source.matchAll(/(const|let)\s+\w+\s*=\s*prisma\.\$transaction\(/g)) found.push(lineOf(m.index))
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
    })
})
