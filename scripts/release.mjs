// Packs the kit and copies the .tgz into each app's vendor/ folder:
//   npm run release -- ~/live_space ~/puntada
// Then, in each app: npm install --save-exact ./vendor/<file>.tgz
// The apps never need access to this private repo, in CI or anywhere else.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const targets = process.argv.slice(2);
const file = execFileSync('npm', ['pack', '--silent'], { encoding: 'utf8' }).trim().split('\n').at(-1);
console.log(`Packed ${file}`);
for (const target of targets) {
  const app = resolve(target.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  if (!existsSync(join(app, 'package.json'))) {
    console.error(`  ✗ ${app}: no package.json`);
    process.exitCode = 1;
    continue;
  }
  mkdirSync(join(app, 'vendor'), { recursive: true });
  copyFileSync(file, join(app, 'vendor', file));
  console.log(`  → ${app}/vendor/${file}\n    cd ${app} && npm install --save-exact ./vendor/${file}`);
}
