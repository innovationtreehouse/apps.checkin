import { PrismaClient } from '../src/generated/prisma/client'
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import * as dotenv from 'dotenv'

dotenv.config()

const connectionString = `${process.env.DATABASE_URL}`
const pool = new Pool({ connectionString })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

async function main() {
    console.log("Adding 20 test members and marking them as present...")
    for (let i = 1; i <= 20; i++) {
        // Create household
        const household = await prisma.household.create({
            data: { name: `Test Family ${i}`, line1: `123 Test St ${i}` }
        })

        // Create participant
        const participant = await prisma.person.create({
            data: {
                email: `testmember${i}@example.com`,
                name: `Test Member ${i}`,
                householdId: household.id,
            }
        })

        // Make household lead (a1: flag on the person).
        await prisma.person.update({
            where: { id: participant.id },
            data: { isHouseholdLead: true },
        });

        // Create membership
        await prisma.orgMembership.create({
            data: {
                status: 'ACTIVE',
                householdId: household.id
            }
        })

        // Mark them as arrivedAt so they show up as "present" just in case limitToPresent is true
        await prisma.visit.create({
            data: {
                personId: participant.id,
                arrivedAt: new Date()
            }
        })
        
        console.log(`Added Test Member ${i} and marked as present.`);
    }
    console.log("Done!");
}

main().catch(console.error).finally(() => prisma.$disconnect())
