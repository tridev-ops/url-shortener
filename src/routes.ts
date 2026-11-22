import { randomBytes } from 'node:crypto'
import { FastifyInstance } from 'fastify'
import "dotenv/config";
import { eq, sql } from 'drizzle-orm'
import { db } from "./db"
import { links } from './db/schema'
import Redis from 'ioredis'
import 'dotenv/config'
import rateLimit from "@fastify/rate-limit";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
    throw new Error("REDIS_URL is not configured");
}
const redis = new Redis(redisUrl);

const shortenSchema = {
  body: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string", minLength: 1 },
      customCode: {
        type: "string",
        pattern: "^[a-zA-Z0-9_-]{3,20}$",
      },
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

async function createShortLink(originalUrl: string, customCode: string | undefined, maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const code = customCode || generateCode(4);

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
            if (customCode && getPgErrorCode(err) === "23505") {
                // If a custom code is provided and there's a uniqueness violation, throw an error
                throw new Error("Custom code is already in use");
            }
            
            if (getPgErrorCode(err) === "23505") {
                continue; // Collision on `code` — generate a new one and retry
            }

            throw err; // Any other error (connection, syntax, etc.) should fail immediately
        }
    }

    throw new Error("Failed to generate a unique short code after max retries");
}

function buildShortUrl(code: string): string {
    const rawBase = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    const normalizedBase = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;
    return new URL(code, normalizedBase).toString();
}

export default function routes(fastify: FastifyInstance) {
    // Register the plugin on this Fastify instance before defining routes.
    fastify.register(rateLimit, {
        global: false,
        redis,
    });

    fastify.post("/shorten", {
        schema: shortenSchema, config: {
            rateLimit: {
                max: 20, // max requests per window
                timeWindow: "1 minute",
                keyGenerator: (request) => `rate:shorten:${request.ip}`,
            },
        },
    }, async (request, reply) => {
        const { url, customCode } = request.body as { url: string; customCode: string | undefined };

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

        const link = await createShortLink(url, customCode);
        const shortUrl = buildShortUrl(link.code);
        return reply.code(201).send({
            code: link.code,
            shortUrl,
        });
    });

    fastify.get("/:code", async (request, reply) => {
        const { code } = request.params as { code: string }

        const cacheKey = `url:${code}`;
        let originalUrl: string | null = null;

        try {
            originalUrl = await redis.get(cacheKey);
        } catch (err) {
            // If Redis is unreachable or times out, don't fail the redirect—fall back to Postgres
            request.log.warn({ err, cacheKey }, "Redis GET failed, falling back to DB");
        }

        if (originalUrl === null) {
            console.log(`Cache miss for code: ${code}, fetching from DB`);
            // Fetch url from db
            const link = await db.select().from(links).where(eq(links.code, code)).limit(1)

            if (link.length === 0) {
                return reply.code(404).send({ error: 'Link not found' })
            }

            originalUrl = link[0].originalUrl

            // Cache the URL in Redis for 1 hour (3600 seconds) on a cache miss
            try {
                await redis.set(cacheKey, link[0].originalUrl, "EX", 3600);
            } catch (err) {
                request.log.warn({ err, cacheKey }, "Redis SET failed, continuing redirect");
            }
        } else {
            console.log(`Cache hit for code: ${code}, redirecting to ${originalUrl}`);
        }

        // Increment clicks
        await db.update(links)
            .set({ clicks: sql`${links.clicks} + 1` })
            .where(eq(links.code, code))

        // Redirect to original url
        return reply.redirect(originalUrl)
    })

    fastify.get("/:code/stats", async (request, reply) => {
        const { code } = request.params as { code: string }

        const link = await db.select().from(links).where(eq(links.code, code)).limit(1)

        if (link.length === 0) {
            return reply.code(404).send({ error: 'Link not found' })
        }

        return reply.send({
            code: link[0].code,
            originalUrl: link[0].originalUrl,
            clicks: link[0].clicks,
        })
    })
}