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

        // Generate a random 6 character code
        const code = randomBytes(4).toString('base64url')

        // Insert the code with orignal url to the database
        await db.insert(links).values({ code, originalUrl: url }).returning()
        reply.code(201).send({ code })
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