import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';

export class TickerHub {
  private readonly clients = new Map<string, Set<{ send(data: string): void }>>();
  publish(marketId: string, event: unknown) {
    const payload = JSON.stringify(event);
    for (const client of this.clients.get(marketId) ?? []) client.send(payload);
  }
  async register(app: FastifyInstance) {
    await app.register(websocket);
    app.get('/api/markets/:id/ticker', { websocket: true }, (socket, request) => {
      const { id } = request.params as { id: string };
      const listeners = this.clients.get(id) ?? new Set(); listeners.add(socket); this.clients.set(id, listeners);
      socket.on('close', () => { listeners.delete(socket); if (listeners.size === 0) this.clients.delete(id); });
    });
  }
}
