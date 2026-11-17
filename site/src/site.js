// dpdp-kit site: theme toggle, copy buttons, scroll reveals, docs menu, and the drift demo.
(() => {
  const root = document.documentElement;
  root.classList.remove("no-js");
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };

  // theme: follows the system until the visitor picks one
  const toggle = document.getElementById("theme");
  toggle?.addEventListener("click", () => {
    const current = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    store.set("dpdp-theme", next);
  });

  // copy buttons
  const check = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-copy], .code .copy");
    if (!btn) return;
    const text = btn.dataset.copy ?? btn.closest(".code").querySelector("pre").innerText;
    try {
      await navigator.clipboard.writeText(text.trimEnd());
      const before = btn.innerHTML;
      btn.innerHTML = check; btn.classList.add("done"); btn.setAttribute("aria-label", "Copied");
      setTimeout(() => { btn.innerHTML = before; btn.classList.remove("done"); btn.setAttribute("aria-label", "Copy"); }, 1600);
    } catch {}
  });

  // docs menu on small screens
  const side = document.querySelector(".side");
  side?.querySelector(".side-toggle")?.addEventListener("click", () => {
    const open = side.classList.toggle("open");
    side.querySelector(".side-toggle").setAttribute("aria-expanded", String(open));
  });

  // reveal on scroll
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const items = document.querySelectorAll(".reveal");
  if (reduce || !("IntersectionObserver" in window)) items.forEach((el) => el.classList.add("in"));
  else {
    const io = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
    }), { rootMargin: "0px 0px -8% 0px" });
    items.forEach((el, i) => { el.style.transitionDelay = `${Math.min(i % 4, 3) * 70}ms`; io.observe(el); });
  }

  // ---------- the drift demo ----------
  const demo = document.getElementById("demo");
  if (!demo) return;
  const code = document.getElementById("demo-code");
  const term = document.getElementById("demo-term");
  const tabs = demo.querySelectorAll(".bar .tab[data-tab]");
  const steps = document.querySelectorAll("#demo-steps span");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

  const SCHEMA_TOP = `<span class="k">export const</span> users = <span class="f">pgTable</span>(<span class="s">"users"</span>, {
  id: <span class="f">uuid</span>().<span class="f">primaryKey</span>(),
  phone: <span class="f">text</span>(),
  name: <span class="f">text</span>(),
`;
  const SCHEMA_END = `});`;
  const NEW_COL = `  aadhaar_number: text(),`;
  const CONFIG_TOP = `data: {
  users: {
    table: <span class="s">"users"</span>,
    subject: <span class="s">"id"</span>,
    fields: {
      phone: { category: <span class="s">"contact"</span>, purposes: [<span class="s">"account"</span>] },
      name:  { category: <span class="s">"identity"</span>, purposes: [<span class="s">"account"</span>] },
`;
  const CONFIG_END = `    },
  },
},`;
  const NEW_MAP = `      aadhaar_number: { category: "identity", purposes: ["kyc"] },`;
  const CMD = "npx dpdp-kit audit --schema src/db/schema.ts";
  const FAIL = `<span class="r">✖ error</span>    schema.users.aadhaar_number
             Looks like personal data (identity, matched
             "aadhaar") but isn't in the data map.

<span class="r">1 error(s), 0 warning(s)</span>`;
  const PASS = `<span class="g">✔ No problems found.</span>`;
  const caret = '<span class="caret"></span>';

  const setTab = (name) => tabs.forEach((t) => t.classList.toggle("on", t.dataset.tab === name));
  const setStep = (n) => steps.forEach((s, i) => s.classList.toggle("on", i === n));
  const schema = (typed, done) => SCHEMA_TOP + (typed === null ? "" : `<span class="add">${esc(typed)}${done ? "" : caret}</span>`) + SCHEMA_END;
  const config = (typed, done) => CONFIG_TOP + (typed === null ? "" : `<span class="add">${esc(typed)}${done ? "" : caret}</span>`) + CONFIG_END;
  const prompt = (typed, done) => `<span class="d">$</span> ${esc(typed)}${done ? "" : caret}`;

  if (reduce) { // a still picture of the end state
    setTab("config"); setStep(3);
    code.innerHTML = config(NEW_MAP, true);
    term.innerHTML = prompt(CMD, true) + "\n" + PASS;
    return;
  }

  let visible = false, running = false;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async () => { while (!visible) await wait(250); };
  async function type(render, text, el, speed = 38) {
    for (let i = 0; i <= text.length; i++) { await until(); el.innerHTML = render(text.slice(0, i), false); await wait(speed + Math.random() * 30); }
    el.innerHTML = render(text, true);
  }
  async function loop() {
    running = true;
    for (;;) {
      setTab("schema"); setStep(0);
      code.innerHTML = schema(null); term.innerHTML = prompt("", false);
      await wait(900);
      await type(schema, NEW_COL, code, 55);
      await wait(700);
      setStep(1);
      await type(prompt, CMD, term, 30);
      await wait(500);
      term.innerHTML = prompt(CMD, true) + "\n" + FAIL;
      await wait(2600);
      setTab("config"); setStep(2);
      code.innerHTML = config(null);
      await wait(700);
      await type(config, NEW_MAP, code, 32);
      await wait(700);
      setStep(3);
      term.innerHTML = prompt("", false);
      await type(prompt, CMD, term, 22);
      await wait(450);
      term.innerHTML = prompt(CMD, true) + "\n" + PASS;
      await wait(3600);
    }
  }
  code.innerHTML = schema(null); term.innerHTML = prompt("", false); setStep(0);
  new IntersectionObserver(([en]) => {
    visible = en.isIntersecting;
    if (visible && !running) loop();
  }).observe(demo);
})();
