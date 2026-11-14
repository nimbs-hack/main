const bunBin = process.execPath;
const env = { ...process.env, API_PORT: process.env.API_PORT ?? "3002" };

const apiProc = Bun.spawn([bunBin, "run", "--hot", "apps/api/src/index.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  env,
});

const webProc = Bun.spawn([bunBin, "run", "--filter", "@nimbs/web", "dev"], {
  stdout: "inherit",
  stderr: "inherit",
  env,
});

function shutdown(exitCode = 0): never {
  apiProc.kill();
  webProc.kill();
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

const exitCode = await Promise.race([apiProc.exited, webProc.exited]);
shutdown(exitCode);
