import readline from 'node:readline';

function rl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

export function askHidden(question) {
  return new Promise((resolve) => {
    const iface = rl();
    process.stdout.write(question);
    iface._writeToOutput = () => {};
    iface.question('', (answer) => {
      iface.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

export function ask(question) {
  return new Promise((resolve) => {
    const iface = rl();
    iface.question(question, (a) => { iface.close(); resolve(a.trim()); });
  });
}

export async function pickNumber(title, items, defaultIndex) {
  console.log(title);
  items.forEach((it, i) => console.log(`  ${String(i + 1).padStart(2)}) ${it}`));
  for (;;) {
    const a = await ask(`pick [Enter = ${defaultIndex + 1}]: `);
    if (a === '') return defaultIndex;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
    console.log(`enter a number 1-${items.length}`);
  }
}

export async function askYesNo(question, def) {
  const a = await ask(`${question} ${def ? '[Y/n]' : '[y/N]'}: `);
  if (a === '') return def;
  return /^y(es)?$/i.test(a);
}
