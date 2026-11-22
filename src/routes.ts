import { randomBytes } from 'node:crypto'
import { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { db } from "./db"
import { links } from './db/schema'

const shortenSchema = {
    body: {
        type: "object",
        required: ["url"],
        properties: {
            url: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
    },
};

function generateCode(byteLength = 4): string {
    return randomBytes(byteLength).toString("base64url");
}

function getPgErrorCode(err: unknown): string | undefined {
    if (!err || typeof err !== "object") return undefined;
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code;
}

function isLinkAlreadyExists(originalUrl: string): Promise<boolean> {
    return db.select().from(links).where(eq(links.originalUrl, originalUrl)).limit(1).then(result => result.length > 0);
}

async function createShortLink(originalUrl: string, maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const code = generateCode(4);

        try {
            // Check if the original URL already exists in the database
            const exists = await isLinkAlreadyExists(originalUrl);
            if (exists) {
                // Fetch the existing link
                const [existingLink] = await db.select().from(links).where(eq(links.originalUrl, originalUrl)).limit(1);
                return existingLink;
            }

            const [inserted] = await db
                .insert(links)
                .values({ code, originalUrl })
                .returning();

            return inserted;
        } catch (err) {
            if (getPgErrorCode(err) === "23505") {
                continue; // Collision on `code` — generate a new one and retry
            }
            
            throw err; // Any other error (connection, syntax, etc.) should fail immediately
        }
    }

    throw new Error("Failed to generate a unique short code after max retries");
}

export default function routes(fastify: FastifyInstance) {
    fastify.post("/shorten", { schema: shortenSchema }, async (request, reply) => {
        const { url } = request.body as { url: string };

        // Check if url is valid
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(url);
            if (!["http:", "https:"].includes(parsedUrl.protocol)) {
                return reply.code(400).send({ error: "Only http and https URLs are allowed" });
            }
        } catch {
            return reply.code(400).send({ error: "Invalid URL" });
        }

        const link = await createShortLink(url)
        reply.code(201).send({ link })
    });

    fastify.get("/:code", async (request, reply) => {
        const { code } = request.params as { code: string }

        // Fetch url from db
        const link = await db.select().from(links).where(eq(links.code, code)).limit(1)

        if (link.length === 0) {
            return reply.code(404).send({ error: 'Link not found' })
        }

        // Increment clicks
        await db.update(links)
            .set({ clicks: sql`${links.clicks} + 1` })
            .where(eq(links.code, code))

        // Redirect to orignal url
        return reply.redirect(link[0].originalUrl)
    })
}