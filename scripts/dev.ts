const bunBin = process.execPath;

const prep = Bun.spawnSync([bunBin, "run", "scripts/data/prepare-static-data.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env },
});
if (prep.exitCode !== 0) {
  process.exit(prep.exitCode);
}

const webProc = Bun.spawn([bunBin, "run", "--filter", "@nimbs/web", "dev"], {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env },
});

function shutdown(): void {
  webProc.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const exitCode = await webProc.exited;
process.exit(exitCode);
