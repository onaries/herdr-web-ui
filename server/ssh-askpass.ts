// OpenSSH launches this helper without a terminal. Credentials travel only through a private
// socket (a named pipe on Windows) and stdout back to ssh, never argv, environment or a file.
// The token proves to the server that this helper was started by its own ssh: on Windows any
// account on the PC can open a named pipe by name.
import { connect } from "node:net";
const socket = connect(process.env["HERDR_ASKPASS_SOCKET"]!);
socket.setTimeout(300_000, () => process.exit(1));
socket.on("connect", () => socket.write(JSON.stringify({ token: process.env["HERDR_ASKPASS_TOKEN"] ?? "", prompt: process.argv[2] ?? "SSH authentication" }) + "\n"));
let response = "";
socket.on("data", (chunk) => {
  response += chunk;
  if (!response.includes("\n")) return;
  try { process.stdout.write(String(JSON.parse(response).answer) + "\n"); socket.end(); }
  catch { process.exit(1); }
});
socket.on("error", () => process.exit(1));
socket.on("close", () => { if (!response.includes("\n")) process.exit(1); });
