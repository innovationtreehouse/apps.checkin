import prisma from '@/lib/prisma'

// The test pool holds one connection. A root-client query issued while a
// transaction holds it must fail fast with a pool-acquire error, not hang.
describe('root-client query while a transaction holds the only connection', () => {
    it('fails within ~2s with a pool-acquire timeout', async () => {
        let caught: unknown
        let elapsedMs = 0
        await prisma.$transaction(
            async (tx) => {
                await tx.$queryRaw`SELECT 1`
                const start = Date.now()
                try {
                    await prisma.$queryRaw`SELECT 1`
                } catch (error) {
                    caught = error
                }
                elapsedMs = Date.now() - start
            },
            { timeout: 60_000 },
        )

        expect(caught).toBeInstanceOf(Error)
        expect((caught as Error).message).toMatch(/timeout exceeded when trying to connect/i)
        expect(elapsedMs).toBeLessThan(5_000)
    }, 60_000)
})
