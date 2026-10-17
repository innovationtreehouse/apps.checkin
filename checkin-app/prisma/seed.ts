import { PrismaClient } from '../src/generated/prisma/client'
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import * as dotenv from 'dotenv'
import { seedBaseline } from '../src/lib/dev/seed-helpers'
import { registerRootClient } from '../src/lib/db-client'

dotenv.config()

const connectionString = `${process.env.DATABASE_URL}`
const pool = new Pool({ connectionString })
const adapter = new PrismaPg(pool)
const prisma = registerRootClient(new PrismaClient({ adapter }))

// The seed logic lives in src/lib/dev/seed-helpers.ts so the dashboard reset/macros share one
// source of truth with this CLI seed (docs/ops/dev-instance.md, "Macros").
seedBaseline(prisma)
    .catch((e) => {
        console.error(e)
        process.exit(1)
    })
    .finally(async () => {
        await prisma.$disconnect()
    })
