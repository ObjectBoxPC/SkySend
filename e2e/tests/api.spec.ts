import { expect, test } from "./support/fixtures.js";

test("an unknown path under /api answers with a JSON 404, not with the app", async ({
  request,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "The server answers the same to every engine");
  for (const [method, path] of [
    ["GET", "/api/does-not-exist"],
    ["GET", "/api/upload/init"],
    ["POST", "/api/health"],
  ] as const) {
    const res = await request.fetch(path, { method });
    expect(res.status(), `${method} ${path}`).toBe(404);
    expect(await res.json(), `${method} ${path}`).toEqual({ error: "Not found" });
  }
  expect((await request.get("/api/health")).ok()).toBe(true);
});
