import { connect, createServer } from 'node:net';
import { isNodeError } from './errors.js';

export const DEFAULT_DEV_PORT = 9292;
const PORT_SEARCH_SPAN = 200;

/**
 * A port counts as free only if nothing answers on it and we can bind it. Both checks matter: macOS
 * lets a process bind 127.0.0.1 even while another is listening on every interface.
 */
export async function isPortFree(port: number): Promise<boolean> {
  if (await answers(port, '127.0.0.1', 300)) return false;
  return (await canBind(port, '127.0.0.1')) && (await canBind(port, '::1'));
}

export function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  return answers(port, host, 500);
}

export async function findFreePort(
  from: number,
  reserved: ReadonlySet<number>,
): Promise<number | undefined> {
  const last = Math.min(from + PORT_SEARCH_SPAN, 65_535);
  for (let port = from; port <= last; port++) {
    if (!reserved.has(port) && (await isPortFree(port))) return port;
  }
  return undefined;
}

function answers(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error) => {
      // No IPv6 on this machine is not a conflict.
      const unavailable =
        isNodeError(error) && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code ?? '');
      resolve(unavailable);
    });
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}
