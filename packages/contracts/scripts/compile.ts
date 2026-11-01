import { execFileSync } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(root, 'src');
const artifactDir = join(root, 'artifacts');
await mkdir(artifactDir, { recursive: true });
const files = (await readdir(sourceDir)).filter((file) => file.endsWith('.cash'));
if (files.length !== 4) throw new Error(`Expected 4 CashScript sources; found ${files.length}`);
for (const file of files) {
  const source = join(sourceDir, file);
  const output = join(artifactDir, `${file.replace(/\.cash$/, '')}.json`);
  execFileSync(process.execPath, [join(root, 'node_modules', 'cashc', 'dist', 'cashc-cli.js'), source, '-o', output],
    { cwd: root, stdio: 'inherit' });
}
console.log(`Compiled ${files.length} contracts into ${artifactDir}`);
