const bunBin = process.execPath;

const apiProc = Bun.spawn([bunBin, "run", "--hot", "apps/api/src/index.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env },
});

const webProc = Bun.spawn([bunBin, "run", "--filter", "@nimbs/web", "dev"], {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env },
});

function shutdown(): void {
  apiProc.kill();
  webProc.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.race([apiProc.exited, webProc.exited]);
shutdown();
