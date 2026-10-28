// split-proxy.mjs — a loopback HTTP-CONNECT proxy that splits traffic by host.
//
// Why it exists: on networks where Google is unreachable, reCAPTCHA validation
// fails unless the browser reaches www.google.com through a local proxy — but
// routing the WHOLE browser through that proxy stretches arena.ai's asset
// waterfall (each tunneled connection pays the proxy's RTT) past the composer
// wait, and every turn times out. Chromium's --proxy-pac-url proved unreliable
// in headless Windows builds, so we terminate CONNECT locally instead and pick
// the upstream per host: allowlisted hosts tunnel through the SOCKS5 upstream,
// everything else connects directly.
import net from "node:net";
import { log } from "./util.mjs";

const DEFAULT_HOSTS =
  "google.com,gstatic.com,recaptcha.net,googleapis.com,googleusercontent.com";

function socks5Tunnel(socksHost, socksPort, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: socksHost, port: socksPort });
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(15_000, () => fail(new Error(`SOCKS5 connect to ${host}:${port} timed out`)));
    socket.once("error", fail);
    socket.once("connect", () => {
      // Greet with "no auth" and wait for the method reply before asking for
      // the tunnel; writing the connect request early confuses some servers.
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    let stage = 0;
    socket.on("data", function onData(chunk) {
      if (stage === 0) {
        if (chunk.length < 2 || chunk[0] !== 0x05 || chunk[1] !== 0x00) {
          return fail(new Error(`SOCKS5 server rejected auth: ${chunk.toString("hex")}`));
        }
        stage = 1;
        const hostBuf = Buffer.from(host, "utf8");
        const request = Buffer.alloc(7 + hostBuf.length);
        request[0] = 0x05; // version
        request[1] = 0x01; // CONNECT
        request[2] = 0x00; // reserved
        request[3] = 0x03; // ATYP: domain name (upstream does the DNS lookups)
        request[4] = hostBuf.length;
        hostBuf.copy(request, 5);
        request.writeUInt16BE(port, 5 + hostBuf.length);
        socket.write(request);
        return;
      }
      socket.off("data", onData);
      socket.setTimeout(0);
      if (chunk.length < 2 || chunk[1] !== 0x00) {
        return fail(new Error(`SOCKS5 tunnel to ${host}:${port} refused: ${chunk.toString("hex")}`));
      }
      resolve(socket);
    });
  });
}

function directTunnel(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
  });
}

/**
 * Start the loopback listener. `upstream` is the existing proxy URL (only
 * socks5:// is understood); hosts ending in one of `proxyHosts` go through it,
 * the rest connect directly. Returns the net.Server.
 */
export function startSplitProxy({ port = 18080, upstream = "", proxyHosts = "" } = {}) {
  const match = /^socks5:\/\/([^/:]+):(\d+)/i.exec(upstream || "");
  if (!match) {
    throw new Error(`split proxy needs a socks5:// upstream, got: ${upstream || "(empty)"}`);
  }
  const socksHost = match[1];
  const socksPort = Number(match[2]);
  const suffixes = (proxyHosts || process.env.ARENA_SPLIT_PROXY_HOSTS || DEFAULT_HOSTS)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const viaProxy = (host) =>
    suffixes.some((s) => host === s || host.endsWith(`.${s}`));

  const server = net.createServer((client) => {
    let head = Buffer.alloc(0);
    client.on("error", () => client.destroy());
    client.on("data", function onData(chunk) {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.off("data", onData);
      const request = head.slice(0, end).toString("latin1");
      const m = /^CONNECT\s+([^\s:]+):(\d+)\s+HTTP\//i.exec(request);
      if (!m) {
        // Only CONNECT is needed for an https-only browser session.
        client.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
        return;
      }
      const host = m[1].toLowerCase();
      const port = Number(m[2]);
      const tunnel = viaProxy(host)
        ? socks5Tunnel(socksHost, socksPort, host, port)
        : directTunnel(host, port);
      tunnel
        .then((up) => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          // Everything after the handshake is opaque TLS — splice and forget.
          up.pipe(client);
          client.pipe(up);
          const close = () => {
            client.destroy();
            up.destroy();
          };
          client.on("error", close);
          up.on("error", close);
          client.on("close", close);
          up.on("close", close);
        })
        .catch((error) => {
          log.warn("split-proxy", `tunnel to ${host}:${port} failed`, { error: error.message });
          client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        });
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}
