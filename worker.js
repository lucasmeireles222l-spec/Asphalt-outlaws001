/* ASPHALT OUTLAWS — Cloudflare Worker + Durable Object
 *  /ws      → WebSocket do multiplayer (todas as salas vivem no Durable Object "GameHub")
 *  /health  → status JSON
 *  demais   → arquivos estáticos da pasta public/ (index.html, sw.js, version.json, manifest, ícones)
 * Segredo necessário (NÃO vai no código): SUPABASE_SERVICE_KEY  (Settings > Variables and Secrets). */
import { createHub } from './hub.js';

export class GameHub {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.hub = createHub(env, { log: (...a) => console.log(...a) });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json(this.hub.health(), { headers: { 'Cache-Control': 'no-store' } });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Use WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    const conn = this.hub.accept(server);
    server.addEventListener('message', ev => { conn.onMessage(typeof ev.data === 'string' ? ev.data : ''); });
    server.addEventListener('close', () => conn.onClose());
    server.addEventListener('error', () => conn.onClose());
    return new Response(null, { status: 101, webSocket: client });
  }
}

const originOk = (request, env) => {
  const o = request.headers.get('Origin'); if (!o) return true;           /* clientes não-navegador */
  if (o === new URL(request.url).origin) return true;                     /* o próprio site */
  return String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).includes(o);
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' || url.pathname === '/health') {
      if (url.pathname === '/ws' && !originOk(request, env)) return new Response('Origem não permitida', { status: 403 });
      const stub = env.GAME_HUB.get(env.GAME_HUB.idFromName('main'));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);                                     /* jogo, sw.js, version.json, manifest, ícones */
  }
};
