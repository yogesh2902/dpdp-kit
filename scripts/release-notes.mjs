// Print the GitHub Release notes for one version: its section of CHANGELOG.md, plus install and
// docs links. Exits with an error if CHANGELOG.md has no section for the version.
// usage: node scripts/release-notes.mjs 0.3.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/release-notes.mjs <version>");
  process.exit(1);
}

const changelog = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../CHANGELOG.md"), "utf8");
const lines = changelog.split("\n");
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
if (start === -1) {
  console.error(`CHANGELOG.md has no "## ${version}" section. Add one before releasing.`);
  process.exit(1);
}
const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
const section = lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();

console.log(`${section}

## Install

\`\`\`bash
npm i dpdp-kit@${version}
\`\`\`

- Docs: https://dpdp-kit.js.org/
- npm: https://www.npmjs.com/package/dpdp-kit/v/${version}
- Full changelog: https://github.com/yogesh2902/dpdp-kit/blob/main/CHANGELOG.md`);
