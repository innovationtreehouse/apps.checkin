// Loads the real @/lib/prisma module under a chosen NODE_ENV with the client,
// pool and extensions replaced by recorders, so the test asserts which
// extensions and pool options each environment wires up.

interface LoadedConfig {
    extensions: unknown[];
    poolOptions: { connectionTimeoutMillis?: number };
    retryExtension: unknown;
}

const env = process.env as Record<string, string | undefined>;

function loadPrismaUnder(nodeEnv: string): LoadedConfig {
    const extensions: unknown[] = [];
    let poolOptions: { connectionTimeoutMillis?: number } = {};
    const retryExtension = { name: 'aurora-resume-retry' };
    const original = env.NODE_ENV;
    env.NODE_ENV = nodeEnv;
    try {
        jest.resetModules();
        jest.isolateModules(() => {
            jest.doMock('@/generated/prisma/client', () => {
                class FakePrismaClient {
                    $extends(ext: unknown) {
                        extensions.push(ext);
                        return this;
                    }
                }
                return { PrismaClient: FakePrismaClient };
            });
            jest.doMock('pg', () => ({
                Pool: class {
                    constructor(opts: { connectionTimeoutMillis?: number }) {
                        poolOptions = opts;
                    }
                },
            }));
            jest.doMock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
            jest.doMock('@/lib/prismaEmailNormalize', () => ({ emailNormalizeExtension: { name: 'email-normalize' } }));
            jest.doMock('@/lib/auroraResumeRetry', () => ({ auroraResumeRetryExtension: retryExtension }));
            jest.requireActual('@/lib/prisma');
        });
    } finally {
        env.NODE_ENV = original;
    }
    return { extensions, poolOptions, retryExtension };
}

describe('prisma client config per environment', () => {
    beforeEach(() => {
        delete (globalThis as { prismaGlobal?: unknown }).prismaGlobal;
    });
    afterEach(() => {
        delete (globalThis as { prismaGlobal?: unknown }).prismaGlobal;
    });

    it.each(['production', 'development'])('%s applies the aurora resume retry and a 10s acquire timeout', (nodeEnv) => {
        const { extensions, poolOptions, retryExtension } = loadPrismaUnder(nodeEnv);
        expect(extensions).toContain(retryExtension);
        expect(poolOptions.connectionTimeoutMillis).toBe(10_000);
    });

    it('test skips the resume retry and uses a 2s acquire timeout', () => {
        const { extensions, poolOptions, retryExtension } = loadPrismaUnder('test');
        expect(extensions).not.toContain(retryExtension);
        expect(extensions).toHaveLength(1);
        expect(poolOptions.connectionTimeoutMillis).toBe(2_000);
    });
});
