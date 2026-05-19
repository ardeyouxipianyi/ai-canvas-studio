import http from "node:http";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const publicPort = Number(process.env.CHATGPT2API_PUBLIC_PORT || 3000);
const nextPort = Number(process.env.CHATGPT2API_NEXT_PORT || 3001);
const publicHost = process.env.CHATGPT2API_PUBLIC_HOST || "0.0.0.0";
const nextHost = process.env.CHATGPT2API_NEXT_HOST || "127.0.0.1";
const backendOrigin = new URL(process.env.CHATGPT2API_BACKEND_URL || "http://127.0.0.1:8000");
const webDir = dirname(fileURLToPath(import.meta.url));
const apiPrefixes = ["/v1/", "/api/", "/auth/", "/images/", "/image-thumbnails/"];
const apiExact = new Set(["/version"]);
const handledSocketErrors = new WeakSet();

function absorbSocketError(socket) {
  if (!socket || handledSocketErrors.has(socket)) return;
  handledSocketErrors.add(socket);
  socket.on("error", () => {});
}

function isBackendPath(url = "") {
  const pathname = new URL(url, `http://127.0.0.1:${publicPort}`).pathname;
  return apiExact.has(pathname) || apiPrefixes.some((prefix) => pathname.startsWith(prefix));
}

function proxyHttp(req, res, target) {
  const headers = { ...req.headers };
  headers.host = req.headers.host || `127.0.0.1:${publicPort}`;
  headers["x-forwarded-host"] = req.headers.host || `127.0.0.1:${publicPort}`;
  headers["x-forwarded-proto"] = "http";
  absorbSocketError(req.socket);
  absorbSocketError(res.socket);

  const closeWithProxyError = (error) => {
    if (res.destroyed) return;
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { message: error?.message || "proxy error" } }));
      return;
    }
    res.destroy(error);
  };

  const proxyReq = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.on("error", closeWithProxyError);
      proxyRes.pipe(res);
    },
  );
  proxyReq.setTimeout(0);
  proxyReq.on("error", closeWithProxyError);
  req.on("aborted", () => proxyReq.destroy());
  req.on("error", () => proxyReq.destroy());
  res.on("error", () => proxyReq.destroy());
  req.pipe(proxyReq);
}

function proxyUpgrade(req, socket, head, target) {
  absorbSocketError(socket);
  const headers = { ...req.headers };
  headers.host = `${target.hostname}:${target.port}`;
  const proxyReq = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: req.url,
    headers,
  });
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`
      + Object.entries(proxyRes.headers)
        .flatMap(([key, value]) => Array.isArray(value) ? value.map((item) => [key, item]) : [[key, value]])
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n")
      + "\r\n\r\n",
    );
    if (proxyHead.length) socket.write(proxyHead);
    if (head.length) proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxyReq.on("error", () => socket.destroy());
  proxyReq.end();
}

const next = spawn(
  "npx",
  ["next", "dev", "--webpack", "-H", nextHost, "-p", String(nextPort)],
  {
    cwd: webDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      PORT: String(nextPort),
    },
  },
);

const server = http.createServer((req, res) => {
  req.setTimeout(0);
  res.setTimeout(0);
  if (isBackendPath(req.url)) {
    proxyHttp(req, res, backendOrigin);
    return;
  }
  proxyHttp(req, res, new URL(`http://${nextHost}:${nextPort}`));
});

server.on("clientError", (_error, socket) => {
  socket.destroy();
});

server.on("upgrade", (req, socket, head) => {
  proxyUpgrade(req, socket, head, new URL(`http://${nextHost}:${nextPort}`));
});

server.timeout = 0;
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

server.listen(publicPort, publicHost, () => {
  console.log(`[unified] http://${publicHost}:${publicPort} -> web:${nextHost}:${nextPort}, api:${backendOrigin.origin}`);
});

function shutdown() {
  server.close();
  next.kill();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
