import http from "node:http";
import net from "node:net";

// Listens on 127.0.0.1, on port 0 (any free port) unless one is given, and
// resolves with the port it got. Other test runs on the machine can't collide.
export const listen = (server: http.Server, port = 0): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as net.AddressInfo).port);
    });
  });

// A port that was free a moment ago, for a server in another process.
export const freePort = async (): Promise<number> => {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
};
