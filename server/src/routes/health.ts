import type { FastifyInstance } from 'fastify';

/** `GET /api/health` — liveness check, no auth. */
export default async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true }));
}
