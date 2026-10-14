import http from "node:http";
import type { AddressInfo } from "node:net";
import { listen } from "./listen.ts";

const page = (body: string) => `<!doctype html><html><body style="font-family:sans-serif;padding:40px">${body}</body></html>`;

// The websites the extension fills: a sign-in form at /, the same form framed
// by a same-site (/framed on localhost) or cross-site (/cross on 127.0.0.1)
// page, a sign-up form and a one-time-code form.
export const startSite = async (port?: number) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    if (req.url === "/framed" || req.url === "/cross") {
      res.end(
        page(`<h1>${req.url === "/framed" ? "Same-site frame" : "Cross-site frame"}</h1>
<iframe id="login" src="http://localhost:${(server.address() as AddressInfo).port}/" style="width:520px;height:360px;border:1px solid #ccc"></iframe>`),
      );
      return;
    }
    if (req.url === "/signup") {
      res.end(
        page(`<h1>Create account</h1>
<form style="width:320px;display:flex;flex-direction:column;gap:8px">
<label>Email <input id="email" type="email"></label>
<label>Password <input id="new1" type="password" autocomplete="new-password" maxlength="16" style="width:100%;height:32px"></label>
<label>Confirm <input id="new2" type="password" autocomplete="new-password" maxlength="16" style="width:100%;height:32px"></label>
</form>`),
      );
      return;
    }
    if (req.url === "/2fa") {
      res.end(
        page(`<h1>Two-step verification</h1>
<form style="width:320px"><label>Code <input id="otp" type="text" autocomplete="one-time-code" style="width:100%;height:32px"></label></form>`),
      );
      return;
    }
    res.end(
      page(`<h1>Sign in</h1>
<form id="f" style="width:320px;display:flex;flex-direction:column;gap:8px">
<label>Username <input id="user" type="text" autocomplete="username" pattern="[^!]*" style="width:100%;height:32px"></label>
<label>Password <input id="pw" type="password" style="width:100%;height:32px"></label>
<button type="submit">Sign in</button>
</form>
<script>
window.events=[];
for (const id of ["user","pw"]) document.getElementById(id).addEventListener("input", e => window.events.push(id+"="+e.target.value));
document.getElementById("f").addEventListener("submit", e => { e.preventDefault(); window.submitted = true; });
</script>`),
    );
  });
  const bound = await listen(server, port);
  return {
    url: `http://localhost:${bound}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
