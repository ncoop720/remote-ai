import type { FastifyReply } from 'fastify';
import type { ServerEvent } from '../../shared/types.js';

/** Server-sent events to every open browser tab. */
export class EventHub {
  private readonly clients = new Set<FastifyReply>();

  subscribe(reply: FastifyReply): void {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    this.clients.add(reply);

    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    reply.raw.on('close', () => {
      clearInterval(ping);
      this.clients.delete(reply);
    });
  }

  broadcast(event: ServerEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) client.raw.write(frame);
  }
}
