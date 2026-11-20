// Build the dpdp-kit website into site/dist: the landing page plus docs from site/docs/*.md.
// usage: node site/build.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";
import { codeToHtml } from "shiki";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
const SITE_URL = "https://dpdp-kit.js.org/";
const REPO = "https://github.com/yogesh2902/dpdp-kit";
const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));

const NAV = [
  { group: "Getting started", pages: ["index", "quick-start"] },
  { group: "Guides", pages: ["config", "audit", "notices", "consent", "objections", "erasure", "rights", "security", "breaches", "transfers", "guards", "http", "client", "react", "react-native", "events", "daily", "evidence", "storage"] },
  { group: "Reference", pages: ["responsibility", "law", "roadmap"] },
];

const ICONS = {
  copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  github: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.62 1.58.23 2.75.11 3.04.74.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>',
  npm: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 7h20v9h-10v1.5H7.5V16H2V7Zm1.6 7.4h2.2v-5.8h1.4v5.8h1.3V8.6H3.6v5.8Zm5.5-5.8v7.3h2.8v-1.5h2.8V8.6H9.1Zm2.8 1.5h1.4v2.8h-1.4v-2.8Zm4.1-1.5v5.8h2.1v-4.3h1.4v4.3h1.4v-4.3h1.4v4.3h1.4V8.6H16Z"/></svg>',
  theme: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>',
  shield: '<svg width="22" height="22" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="sg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d47a52"/><stop offset="1" stop-color="#8fa37a"/></linearGradient></defs><path d="M24 3 L42 10 V23 C42 34 34.5 41.5 24 45 C13.5 41.5 6 34 6 23 V10 Z" fill="url(#sg)"/><path d="M16 24.5 L21.5 30 L32.5 18.5" fill="none" stroke="#fbf8f2" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");

async function highlight(code, lang) {
  const known = ["ts", "js", "bash", "yaml", "json", "jsonc", "sql"];
  const html = await codeToHtml(code, {
    lang: known.includes(lang) ? lang : "text",
    themes: { light: "vitesse-light", dark: "vitesse-dark" },
    defaultColor: false,
  });
  const label = lang && lang !== "text" ? `<span class="lang">${esc(lang)}</span>` : "";
  return `<div class="code">${label}<button class="copy" aria-label="Copy">${ICONS.copy}</button>${html}</div>`;
}

// ---------- markdown ----------
const marked = new Marked({
  async: true,
  gfm: true,
  async walkTokens(token) {
    if (token.type === "code") token.html = await highlight(token.text, token.lang || "text");
  },
  renderer: {
    code(token) { return token.html; },
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      if (depth === 1) return `<h1>${inner}</h1>`;
      const id = slugify(inner);
      return `<h${depth} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>`;
    },
  },
});

function frontMatter(src) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(src);
  if (!m) throw new Error("missing front matter");
  const meta = Object.fromEntries(m[1].split("\n").map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  return { meta, body: src.slice(m[0].length) };
}

// ---------- page shell ----------
function page({ title, description, path, body, active, docs = false }) {
  const depth = path.split("/").filter(Boolean).length;
  const base = depth ? "../".repeat(depth) : "./";
  const url = SITE_URL + path;
  const full = title ? `${title} · dpdp-kit` : "dpdp-kit · India's DPDP Act, built into your Node.js backend";
  const html = `<!doctype html>
<html lang="en" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE_URL}og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#f4efe6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#171411" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${base}favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="${base}styles.css">
<script>try{var t=localStorage.getItem("dpdp-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body>
<a href="#main" class="skip" style="position:absolute;left:-9999px">Skip to content</a>
<header class="nav">
  <div class="wrap">
    <a class="brand" href="${base}">${ICONS.shield} dpdp-kit</a>
    <nav class="links" aria-label="Main">
      <a class="hide-sm" href="${base}#why">Why</a>
      <a class="hide-sm" href="${base}#roadmap">Roadmap</a>
      <a href="${base}docs/"${active === "docs" ? ' aria-current="page"' : ""}>Docs</a>
      <a class="hide-sm" href="${base}docs/law/"${active === "law" ? ' aria-current="page"' : ""}>The law</a>
      <a class="hide-sm" href="https://www.npmjs.com/package/dpdp-kit" aria-label="npm">${ICONS.npm}</a>
      <a href="${REPO}" aria-label="GitHub">${ICONS.github}</a>
      <button class="icon-btn" id="theme" aria-label="Switch light or dark theme">${ICONS.theme}</button>
    </nav>
  </div>
</header>
<main id="main">
${body}
</main>
<footer>
  <div class="wrap">
    <span>${ICONS.shield.replace('width="22" height="22"', 'width="16" height="16"')} dpdp-kit ${esc(pkg.version)} · MIT or Apache 2.0 · Not legal advice</span>
    <nav aria-label="Footer">
      <a href="${base}docs/">Docs</a>
      <a href="${base}docs/law/">The law, mapped</a>
      <a href="${REPO}">GitHub</a>
      <a href="https://www.npmjs.com/package/dpdp-kit">npm</a>
      <a href="${REPO}/issues">Report an issue</a>
    </nav>
  </div>
</footer>
<script src="${base}site.js" defer></script>
</body>
</html>`;
  return { html: html.replaceAll("{{base}}", base).replace(/\{\{icon:(\w+)\}\}/g, (_, k) => ICONS[k]), docs };
}

// ---------- build ----------
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const write = (path, html) => { const file = join(out, path, path.endsWith(".html") ? "" : "index.html"); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, html); };

// landing: highlight its code samples
let landing = readFileSync(join(here, "src/landing.html"), "utf8");
for (const m of [...landing.matchAll(/<pre data-lang="(\w+)">([\s\S]*?)<\/pre>/g)]) {
  landing = landing.replace(m[0], await highlight(m[2], m[1]));
}
write("", page({
  path: "",
  description: "Open-source Node.js toolkit for India's DPDP Act: typed data map, schema drift checks in CI, tamper-evident consent records, erasure with legal holds, and rights requests with Rule 14 deadlines.",
  body: landing,
}).html);

// docs
const docs = NAV.flatMap((g) => g.pages.map((slug) => {
  const { meta, body } = frontMatter(readFileSync(join(here, "docs", `${slug}.md`), "utf8"));
  return { slug, group: g.group, ...meta, body, path: slug === "index" ? "docs/" : `docs/${slug}/` };
}));
for (const [i, d] of docs.entries()) {
  const depth = d.path.split("/").filter(Boolean).length;
  const base = "../".repeat(depth);
  const link = (p) => base + p.path;
  const side = NAV.map((g) => `<h5>${g.group}</h5>` + docs.filter((x) => x.group === g.group)
    .map((x) => `<a href="${link(x)}"${x === d ? ' aria-current="page"' : ""}>${esc(x.title)}</a>`).join("")).join("");
  const prev = docs[i - 1], next = docs[i + 1];
  const pager = `<nav class="pager" aria-label="Previous and next">${prev ? `<a href="${link(prev)}"><small>Previous</small><span>${esc(prev.title)}</span></a>` : "<span></span>"}${next ? `<a class="next" href="${link(next)}"><small>Next</small><span>${esc(next.title)}</span></a>` : ""}</nav>`;
  const content = await marked.parse(d.body);
  const body = `<div class="wrap docs">
  <aside class="side">
    <button class="side-toggle" aria-expanded="false">${esc(d.title)} <span aria-hidden="true">▾</span></button>
    <nav aria-label="Docs">${side}</nav>
  </aside>
  <article class="prose">
    <span class="label">${esc(d.group)}</span>
    <h1>${esc(d.title)}</h1>
    <p class="desc">${esc(d.description)}</p>
    ${content}
    ${pager}
    <p class="edit"><a href="${REPO}/edit/main/site/docs/${d.slug}.md">Edit this page on GitHub</a></p>
  </article>
</div>`;
  write(d.path, page({ title: d.title, description: d.description, path: d.path, body, active: d.slug === "law" ? "law" : "docs" }).html);
}

// 404, assets, sitemap
write("404.html", page({
  title: "Page not found", description: "This page doesn't exist.", path: "",
  body: `<section class="closing" style="border:0"><div class="wrap"><span class="label">404</span><h2>This page <em>isn't here</em>.</h2><div class="cta"><a class="btn primary" href="${SITE_URL}">Home</a><a class="btn" href="${SITE_URL}docs/">Docs</a></div></div></section>`,
}).html.replaceAll('href="./', `href="${SITE_URL}`).replaceAll('src="./', `src="${SITE_URL}`));
cpSync(join(here, "src/styles.css"), join(out, "styles.css"));
cpSync(join(here, "src/site.js"), join(out, "site.js"));
cpSync(join(here, "public"), out, { recursive: true });
const urls = ["", ...docs.map((d) => d.path)];
writeFileSync(join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE_URL}${u}</loc></url>`).join("\n")}\n</urlset>\n`);
writeFileSync(join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}sitemap.xml\n`);
writeFileSync(join(out, ".nojekyll"), "");
console.log(`built ${urls.length + 1} pages into ${out}`);
