#!/usr/bin/env node
// The status line runs on every redraw, so it loads only its own module.
if (process.argv[2] === "statusline") {
  const { main } = await import("../lib/statusline.mjs");
  process.exitCode = await main(process.argv.slice(3));
} else {
  const { main } = await import("../lib/cli.mjs");
  process.exitCode = await main(process.argv.slice(2));
}
