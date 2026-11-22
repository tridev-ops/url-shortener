import Fastify from 'fastify'
import "dotenv/config"
import routes from './routes'

const fastify = Fastify({
  logger: true
})

fastify.get('/', async (request, reply) => {
  return { hello: 'world' }
})

fastify.register(routes, { prefix: '/' });

/**
 * Run the server!
 */
const start = async () => {
  try {
    await fastify.listen({ port: Number(process.env.PORT) || 3000 })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}
start()