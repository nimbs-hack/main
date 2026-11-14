import { expect, test } from "bun:test";
import { createWeatherRouter } from "./weather";

test("weather evaluation rejects null, boolean and array sol values", async () => {
  const router = createWeatherRouter();
  for (const sol of [null, false, true, [], [1]]) {
    const response = await router.request("/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sol }),
    });
    expect(response.status).toBe(400);
  }
});
