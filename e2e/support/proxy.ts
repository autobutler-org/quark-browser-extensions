import http from "node:http";
import { listen } from "./listen.ts";

export type Logged = Readonly<{ method: string; path: string; body: any }>;

export const logPath = "/__e2e/log";

// Sits between the extension and the Quark (real or mock) and records every
// API request, so a test can check what went over the wire: that sign-in sent
// an auth key and no password, say, which the server's answer alone can't show.
// GET /__e2e/log returns the record and DELETE /__e2e/log clears it.
export const startProxy = async (target: string, port?: number) => {
  const log: Logged[] = [];
  const upstream = new URL(target);

  const server = http.createServer((req, res) => {
    if (req.url === logPath) {
      if (req.method === "DELETE") log.length = 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(log));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (req.method !== "OPTIONS") {
        let body: unknown = null;
        try {
          body = raw.length > 0 ? JSON.parse(raw.toString()) : null;
        } catch {}
        log.push({ method: req.method ?? "GET", path: req.url ?? "/", body });
      }
      const forward = http.request(
        {
          host: upstream.hostname,
          port: upstream.port,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: upstream.host },
        },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(res);
        },
      );
      forward.on("error", (error) => {
        res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: `proxy: ${error.message}` }));
      });
      forward.end(raw);
    });
  });
  const bound = await listen(server, port);
  return {
    url: `http://127.0.0.1:${bound}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
