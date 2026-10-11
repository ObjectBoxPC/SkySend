import { randomBytes } from "node:crypto";
import { expect, scanServer, test } from "./support/fixtures.js";

// Every other test passes when the recording sees nothing, so this one makes sure it sees
// what a leak would look like: a header, a request body and the frames of a WebSocket.
test("the guard sees what reaches the server", async ({ page, request }) => {
  const inHeader = randomBytes(16).toString("hex");
  const inBody = randomBytes(16).toString("hex");
  const inShortFrame = randomBytes(16).toString("hex");
  // Long enough for the 64-bit length of a frame, with the needle in the middle.
  const longFrame = Buffer.concat([randomBytes(40_000), randomBytes(16), randomBytes(40_000)]);
  const inLongFrame = longFrame.subarray(40_000, 40_016);

  await page.goto("/");
  await page.evaluate(
    async ({ inHeader, inBody, inShortFrame, longFrame }) => {
      await fetch("/api/health", { headers: { "X-Probe": inHeader } });
      await fetch("/api/health", { method: "POST", body: inBody });
      // One message per socket: the server ends a session that opens with nonsense, and a
      // browser drops what it has not sent yet once that happens.
      const sendOnce = (message: string | Uint8Array<ArrayBuffer>) =>
        new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(`${location.origin.replace("http", "ws")}/api/upload/ws`);
          socket.onopen = () => socket.send(message);
          socket.onclose = () => resolve();
          socket.onerror = () => reject(new Error("WebSocket failed"));
        });
      await sendOnce(inShortFrame);
      await sendOnce(new Uint8Array(longFrame));
    },
    { inHeader, inBody, inShortFrame, longFrame: [...longFrame] },
  );

  const needles = [
    { name: "header", bytes: Buffer.from(inHeader) },
    { name: "body", bytes: Buffer.from(inBody) },
    { name: "short frame", bytes: Buffer.from(inShortFrame) },
    { name: "long frame", bytes: inLongFrame },
  ];
  await expect
    .poll(async () => (await scanServer(request, needles)).map((hit) => hit.name).sort())
    .toEqual(["body", "header", "long frame", "short frame"]);
});
