#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
import { main } from '../src/cli.js';
// Flush stdout before exiting so piped output is never truncated, then exit
// explicitly: a kept-alive fetch socket would otherwise hold the process open
// for seconds after the command finished.
function finish(code) {
  process.exitCode = code;
  process.stdout.write('', () => process.exit(code));
}
main(process.argv.slice(2)).then(
  (code) => finish(code ?? 0),
  (err) => { console.error(String(err?.message ?? err)); finish(1); }
);
