// Ready-made, unstyled screens built on the hooks: semantic HTML with stable `dpdp-*` class names
// and `data-state` attributes. Import "dpdp-kit/react/styles.css" for the default look.
import { type FormEvent, type ReactNode, useId, useState } from "react";
import type { PersonRequest, PurposeStatus } from "../http.js";
import { NOTICE_LANGUAGES, type NoticeLanguage } from "../languages.js";
import type { NoticeKind } from "../notice.js";
import type { RequestType } from "../records.js";
import { useChanged, useConsents, useDpdpClient, useMyData, useNominees, useNotice, useNoticeLanguages, useRequests, useRights } from "./hooks.js";

/** Every piece of text the components show, besides the notice itself (which comes from the server, in the person's language). */
export interface Labels {
  /** For dates: a BCP 47 locale. Default `"en-IN"`. */
  locale: string;
  loading: string;
  failed: string;
  retry: string;
  saved: string;
  notSaved: string;
  language: string;
  acceptSelected: string;
  rejectAll: string;
  continue: string;
  consentsHeading: string;
  consentsIntro: string;
  alwaysOn: string;
  alwaysOnIntro: string;
  dataHeading: string;
  dataIntro: string;
  noData: string;
  sharedWith: string;
  sharedWithNobody: string;
  download: string;
  requestsHeading: string;
  requestsIntro: string;
  requestType: string;
  requestDetails: string;
  sendRequest: string;
  noRequests: string;
  requestTypes: Record<RequestType, string>;
  statuses: Record<PersonRequest["status"], string>;
  opened: string;
  due: string;
  nomineesHeading: string;
  nomineesIntro: string;
  noNominees: string;
  nomineeName: string;
  nomineeContact: string;
  nomineeRelation: string;
  addNominee: string;
  remove: string;
  contactHeading: string;
  howToAsk: string;
  contact: string;
  identifiers: string;
  answerTimes: string;
  days: (n: number) => string;
  grievances: string;
}

export const DEFAULT_LABELS: Labels = {
  locale: "en-IN",
  loading: "Loading…",
  failed: "Couldn't load this.",
  retry: "Try again",
  saved: "Saved.",
  notSaved: "Couldn't save that change. Please try again.",
  language: "Language",
  acceptSelected: "Accept selected",
  rejectAll: "Reject all",
  continue: "Continue",
  consentsHeading: "Your choices",
  consentsIntro: "Turn each use on or off. You can change your mind at any time.",
  alwaysOn: "Needed to provide the service",
  alwaysOnIntro: "We use your data for these without asking, as the law allows:",
  dataHeading: "Your data",
  dataIntro: "What we hold about you, and who we share it with.",
  noData: "We hold no personal data about you.",
  sharedWith: "Shared with",
  sharedWithNobody: "We don't share your data with anyone.",
  download: "Download a copy",
  requestsHeading: "Your requests",
  requestsIntro: "Ask for a copy, a correction or erasure of your data, or raise a complaint.",
  requestType: "What do you need?",
  requestDetails: "Details (optional)",
  sendRequest: "Send request",
  noRequests: "You haven't made any requests.",
  requestTypes: {
    access: "A summary of my data",
    correction: "Correct or update my data",
    erasure: "Erase my data",
    grievance: "A complaint",
    nomination: "A nominee",
  },
  statuses: { open: "Open", resolved: "Answered", rejected: "Declined" },
  opened: "Made",
  due: "Answer due",
  nomineesHeading: "Your nominee",
  nomineesIntro: "Someone who may use these rights for you if you die or can no longer act yourself.",
  noNominees: "You haven't named anyone.",
  nomineeName: "Name",
  nomineeContact: "Email or phone",
  nomineeRelation: "Relation (optional)",
  addNominee: "Add nominee",
  remove: "Remove",
  contactHeading: "How to reach us",
  howToAsk: "To make a request",
  contact: "Data Protection Officer",
  identifiers: "To identify you, we ask for",
  answerTimes: "We answer",
  days: (n) => `within ${n} day${n === 1 ? "" : "s"}`,
  grievances: "Complaints",
};

const cx = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(" ");

/** A text with any URLs in it made into links. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return <>{parts.map((p, i) => (i % 2 === 1 ? <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a> : p))}</>;
}

/** An on/off switch: a button with `role="switch"`, labelled by the text next to it. */
function Switch(props: { on: boolean; disabled?: boolean; onChange(on: boolean): void; labelledBy: string; describedBy?: string }) {
  return (
    <button
      type="button"
      role="switch"
      className="dpdp-switch"
      aria-checked={props.on}
      aria-labelledby={props.labelledBy}
      {...(props.describedBy ? { "aria-describedby": props.describedBy } : {})}
      data-state={props.on ? "on" : "off"}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
    >
      <span className="dpdp-switch-thumb" aria-hidden="true" />
    </button>
  );
}

function Status({ loading, error, labels, retry }: { loading: boolean; error: unknown; labels: Labels; retry(): void }) {
  if (error) {
    return (
      <p className="dpdp-error" role="alert">
        {labels.failed}{" "}
        <button type="button" className="dpdp-link-button" onClick={retry}>
          {labels.retry}
        </button>
      </p>
    );
  }
  return loading ? <p className="dpdp-loading" aria-busy="true">{labels.loading}</p> : null;
}

const languageName = (code: NoticeLanguage) => {
  try {
    const own = new Intl.DisplayNames([code], { type: "language" }).of(code);
    if (own && own !== code) return own;
  } catch {
    // An engine without this language's names: the English name.
  }
  return NOTICE_LANGUAGES[code];
};

export interface LanguagePickerProps {
  value: NoticeLanguage;
  onChange(language: NoticeLanguage): void;
  labels?: Partial<Labels>;
}

/** A select of the languages the notice is available in, each in its own script. Hidden when there's only English. */
export function LanguagePicker({ value, onChange, labels }: LanguagePickerProps) {
  const l = { ...DEFAULT_LABELS, ...labels };
  const { data } = useNoticeLanguages();
  const id = useId();
  if (!data || data.length < 2) return null;
  return (
    <div className="dpdp-language">
      <label htmlFor={id}>{l.language}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as NoticeLanguage)}>
        {data.map((code) => (
          <option key={code} value={code} lang={code}>
            {languageName(code)}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface ConsentNoticeProps<P extends string = string> {
  /** The language to start in. The person can pick another when there are translations. Default English. */
  language?: NoticeLanguage;
  /** `"existing-users"` for people whose data you held before asking; shows the notice without choices. */
  kind?: NoticeKind;
  /** Called after the choice is recorded: the purposes granted (none for "Reject all") and the language shown. */
  onDone?(result: { granted: P[]; language: NoticeLanguage }): void;
  labels?: Partial<Labels>;
  className?: string;
}

/**
 * The consent request (Section 6) with the notice (Section 5, Rule 3): the notice's own text, in
 * the person's language, with a switch on each purpose, every one off to start with. "Accept
 * selected" and "Reject all" look the same, so neither is pushed. The server records the grant
 * with the notice's version and keeps the notice as proof.
 */
export function ConsentNotice<P extends string = string>({ language: initial = "en", kind = "consent", onDone, labels, className }: ConsentNoticeProps<P>) {
  const l = { ...DEFAULT_LABELS, ...labels };
  const [language, setLanguage] = useState<NoticeLanguage>(initial);
  const notice = useNotice({ language, kind });
  const client = useDpdpClient<P>();
  const changed = useChanged();
  const [chosen, setChosen] = useState<ReadonlySet<P>>(new Set());
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const id = useId();

  const n = notice.data;
  // The notice text is what was saved as proof; show its lines, with each purpose's two lines as a choice.
  const lines = n ? n.text.split("\n") : [];
  const firstItem = lines.findIndex((line) => line.startsWith("• "));
  const head = firstItem === -1 ? lines : lines.slice(0, firstItem);
  const tail = firstItem === -1 ? [] : lines.slice(firstItem + 2 * (n?.items.length ?? 0));

  async function finish(granted: P[]) {
    if (granted.length > 0) {
      setState("saving");
      try {
        await client.grant(granted, { language });
        changed("consents", "data");
      } catch {
        setState("failed");
        return;
      }
    }
    setState("idle");
    onDone?.({ granted, language });
  }

  return (
    <section className={cx("dpdp-notice", className)} aria-labelledby={`${id}-title`} data-state={notice.loading ? "loading" : "ready"} lang={language}>
      <LanguagePicker value={language} onChange={setLanguage} labels={l} />
      <Status loading={notice.loading && !n} error={notice.error} labels={l} retry={notice.reload} />
      {n && (
        <>
          <h2 id={`${id}-title`} className="dpdp-title">{head[0]}</h2>
          {head.slice(1).filter(Boolean).map((line, i) => (
            <p key={i} className="dpdp-intro"><Linkified text={line} /></p>
          ))}
          <ul className="dpdp-purposes">
            {n.items.map((item, i) => {
              const purpose = item.purpose as P;
              const on = chosen.has(purpose);
              const text = lines[firstItem + 2 * i]?.replace(/^• /, "") ?? item.description;
              const dataLine = lines[firstItem + 2 * i + 1]?.trim() ?? "";
              return (
                <li key={purpose} className="dpdp-purpose" data-state={on ? "on" : "off"}>
                  <div className="dpdp-purpose-text">
                    <span id={`${id}-${i}`} className="dpdp-purpose-name">{text}</span>
                    <span id={`${id}-${i}-data`} className="dpdp-purpose-data">{dataLine}</span>
                  </div>
                  {kind === "consent" && (
                    <Switch
                      on={on}
                      disabled={state === "saving"}
                      labelledBy={`${id}-${i}`}
                      describedBy={`${id}-${i}-data`}
                      onChange={(next) => setChosen((s) => (next ? new Set([...s, purpose]) : new Set([...s].filter((p) => p !== purpose))))}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <div className="dpdp-notice-footer">
            {tail.filter(Boolean).map((line, i) => (
              <p key={i}><Linkified text={line} /></p>
            ))}
          </div>
          {state === "failed" && <p className="dpdp-error" role="alert">{l.notSaved}</p>}
          <div className="dpdp-actions">
            {kind === "consent" ? (
              <>
                <button type="button" className="dpdp-button" disabled={state === "saving"} onClick={() => finish([])}>
                  {l.rejectAll}
                </button>
                <button type="button" className="dpdp-button" disabled={state === "saving"} onClick={() => finish(n.items.map((i) => i.purpose as P).filter((p) => chosen.has(p)))}>
                  {l.acceptSelected}
                </button>
              </>
            ) : (
              <button type="button" className="dpdp-button" onClick={() => finish([])}>
                {l.continue}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Section({ heading, intro, children, className }: { heading: string; intro?: string; children: ReactNode; className: string }) {
  const id = useId();
  return (
    <section className={cx("dpdp-section", className)} aria-labelledby={id}>
      <h2 id={id} className="dpdp-heading">{heading}</h2>
      {intro && <p className="dpdp-section-intro">{intro}</p>}
      {children}
    </section>
  );
}

const switchable = (p: PurposeStatus) => p.basis === "consent" || p.legitimateUse === "7(a)";

/** The person's consents and Section 7(a) objections as switches; withdrawing is as easy as granting (Section 6(4)). */
export function ConsentSettings({ labels }: { labels?: Partial<Labels> }) {
  const l = { ...DEFAULT_LABELS, ...labels };
  const consents = useConsents();
  const [said, setSaid] = useState<"" | "saved" | "failed">("");
  const id = useId();
  const choices = consents.purposes.filter(switchable);
  const fixed = consents.purposes.filter((p) => !switchable(p));
  return (
    <Section heading={l.consentsHeading} intro={l.consentsIntro} className="dpdp-consents">
      <Status loading={consents.loading && !consents.data} error={!consents.data && consents.error} labels={l} retry={consents.reload} />
      <ul className="dpdp-purposes">
        {choices.map((p, i) => (
          <li key={p.purpose} className="dpdp-purpose" data-state={p.active ? "on" : "off"}>
            <span id={`${id}-${i}`} className="dpdp-purpose-name">{p.description ?? p.purpose}</span>
            <Switch
              on={p.active}
              disabled={consents.saving.has(p.purpose)}
              labelledBy={`${id}-${i}`}
              onChange={(on) => {
                setSaid("");
                consents.set(p.purpose, on).then(
                  () => setSaid("saved"),
                  () => setSaid("failed"),
                );
              }}
            />
          </li>
        ))}
      </ul>
      {fixed.length > 0 && (
        <div className="dpdp-always-on">
          <p>{l.alwaysOnIntro}</p>
          <ul>
            {fixed.map((p) => (
              <li key={p.purpose}>{p.description ?? p.purpose}</li>
            ))}
          </ul>
        </div>
      )}
      <p className={cx("dpdp-live", said === "failed" && "dpdp-error")} role="status" aria-live="polite">
        {said === "saved" ? l.saved : said === "failed" ? l.notSaved : ""}
      </p>
    </Section>
  );
}

const show = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
const fieldName = (f: string) => {
  const words = f.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** What you hold about the person and who you share it with (Section 11), with a download. */
export function MyData({ labels }: { labels?: Partial<Labels> }) {
  const l = { ...DEFAULT_LABELS, ...labels };
  const summary = useMyData();
  const s = summary.data;
  const held = s?.data.filter((t) => t.rows.length > 0) ?? [];
  function download() {
    if (!s || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(s, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "my-data.json";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Section heading={l.dataHeading} intro={l.dataIntro} className="dpdp-data">
      <Status loading={summary.loading && !s} error={!s && summary.error} labels={l} retry={summary.reload} />
      {s && (
        <>
          {held.length === 0 && <p>{l.noData}</p>}
          {held.map((t) => (
            <dl key={t.key} className="dpdp-table">
              {t.rows.map((row, r) =>
                Object.entries(row).map(([field, value]) => (
                  <div key={`${r}-${field}`} className="dpdp-row">
                    <dt>{t.fields.find((f) => f.field === field)?.label ?? fieldName(field)}</dt>
                    <dd>{show(value)}</dd>
                  </div>
                )),
              )}
            </dl>
          ))}
          <h3 className="dpdp-subheading">{l.sharedWith}</h3>
          {s.sharedWith.length === 0 ? (
            <p>{l.sharedWithNobody}</p>
          ) : (
            <ul className="dpdp-shared">
              {s.sharedWith.map((p) => (
                <li key={p.name}>
                  {p.description ?? p.name}
                  {p.countries?.length ? ` (${p.countries.join(", ")})` : ""}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="dpdp-button" onClick={download}>
            {l.download}
          </button>
        </>
      )}
    </Section>
  );
}

/** The person's rights requests, and a form to make one; the acknowledgement shows once it's sent. */
export function Requests({ labels, types = ["access", "correction", "erasure", "grievance"] }: { labels?: Partial<Labels>; types?: RequestType[] }) {
  const l = { ...DEFAULT_LABELS, ...labels };
  const requests = useRequests();
  const [type, setType] = useState<RequestType>(types[0] ?? "access");
  const [details, setDetails] = useState("");
  const [ack, setAck] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const id = useId();
  const date = new Intl.DateTimeFormat(l.locale, { dateStyle: "medium", timeZone: "Asia/Kolkata" });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setState("saving");
    try {
      const answer = await requests.open(type, details.trim() ? { note: details.trim() } : undefined);
      setAck(answer.acknowledgement.text);
      setDetails("");
      setState("idle");
    } catch {
      setState("failed");
    }
  }

  return (
    <Section heading={l.requestsHeading} intro={l.requestsIntro} className="dpdp-requests">
      <form className="dpdp-form" onSubmit={submit}>
        <label htmlFor={`${id}-type`}>{l.requestType}</label>
        <select id={`${id}-type`} value={type} onChange={(e) => setType(e.target.value as RequestType)}>
          {types.map((t) => (
            <option key={t} value={t}>{l.requestTypes[t]}</option>
          ))}
        </select>
        <label htmlFor={`${id}-details`}>{l.requestDetails}</label>
        <textarea id={`${id}-details`} value={details} rows={3} maxLength={2000} onChange={(e) => setDetails(e.target.value)} />
        <button type="submit" className="dpdp-button" disabled={state === "saving"}>
          {l.sendRequest}
        </button>
      </form>
      <p className={cx("dpdp-live", state === "failed" && "dpdp-error")} role="status" aria-live="polite">
        {state === "failed" ? l.notSaved : ack}
      </p>
      <Status loading={requests.loading && !requests.data} error={!requests.data && requests.error} labels={l} retry={requests.reload} />
      {requests.data && requests.requests.length === 0 && <p>{l.noRequests}</p>}
      <ul className="dpdp-request-list">
        {[...requests.requests].reverse().map((r) => (
          <li key={r.id} className="dpdp-request" data-state={r.status}>
            <span className="dpdp-request-type">{l.requestTypes[r.type]}</span>
            <span className="dpdp-request-status">{l.statuses[r.status]}</span>
            <span className="dpdp-request-dates">
              {l.opened} {date.format(new Date(r.openedAt))}
              {r.status === "open" ? ` · ${l.due} ${date.format(new Date(r.dueAt))}` : ""}
            </span>
            <span className="dpdp-request-ref">{r.id}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** The person's nominees (Section 14, Rule 14(4)): add and remove. */
export function Nominees({ labels }: { labels?: Partial<Labels> }) {
  const l = { ...DEFAULT_LABELS, ...labels };
  const nominees = useNominees();
  const [form, setForm] = useState({ name: "", contact: "", relation: "" });
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const id = useId();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setState("saving");
    try {
      await nominees.nominate({ name: form.name.trim(), contact: form.contact.trim(), ...(form.relation.trim() ? { relation: form.relation.trim() } : {}) });
      setForm({ name: "", contact: "", relation: "" });
      setState("idle");
    } catch {
      setState("failed");
    }
  }

  return (
    <Section heading={l.nomineesHeading} intro={l.nomineesIntro} className="dpdp-nominees">
      <Status loading={nominees.loading && !nominees.data} error={!nominees.data && nominees.error} labels={l} retry={nominees.reload} />
      {nominees.data && nominees.nominees.length === 0 && <p>{l.noNominees}</p>}
      <ul className="dpdp-nominee-list">
        {nominees.nominees.map((n) => (
          <li key={n.id} className="dpdp-nominee">
            <span>
              {n.name}
              {n.relation ? ` (${n.relation})` : ""} · {n.contact}
            </span>
            <button type="button" className="dpdp-link-button" onClick={() => nominees.revoke(n.id).catch(() => setState("failed"))} aria-label={`${l.remove} ${n.name}`}>
              {l.remove}
            </button>
          </li>
        ))}
      </ul>
      <form className="dpdp-form" onSubmit={submit}>
        {(["name", "contact", "relation"] as const).map((k) => (
          <div key={k} className="dpdp-field">
            <label htmlFor={`${id}-${k}`}>{k === "name" ? l.nomineeName : k === "contact" ? l.nomineeContact : l.nomineeRelation}</label>
            <input id={`${id}-${k}`} value={form[k]} required={k !== "relation"} maxLength={200} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
          </div>
        ))}
        <button type="submit" className="dpdp-button" disabled={state === "saving"}>
          {l.addNominee}
        </button>
      </form>
      <p className={cx("dpdp-live", state === "failed" && "dpdp-error")} role="status" aria-live="polite">
        {state === "failed" ? l.notSaved : ""}
      </p>
    </Section>
  );
}

/** How to make a request, what identifies the person, and answer times (Rule 14(1), (3)). */
export function HowToReachUs({ labels }: { labels?: Partial<Labels> }) {
  const l = { ...DEFAULT_LABELS, ...labels };
  const rights = useRights();
  const r = rights.data;
  const days = (d: string) => {
    const m = /^(\d+)d$/.exec(d);
    return m ? l.days(Number(m[1])) : d;
  };
  return (
    <Section heading={l.contactHeading} className="dpdp-contact">
      <Status loading={rights.loading && !r} error={!r && rights.error} labels={l} retry={rights.reload} />
      {r && (
        <dl className="dpdp-table">
          {r.how && (
            <div className="dpdp-row">
              <dt>{l.howToAsk}</dt>
              <dd><Linkified text={r.how} /></dd>
            </div>
          )}
          {r.contact && (
            <div className="dpdp-row">
              <dt>{l.contact}</dt>
              <dd><Linkified text={r.contact} /></dd>
            </div>
          )}
          {r.identifiers.length > 0 && (
            <div className="dpdp-row">
              <dt>{l.identifiers}</dt>
              <dd>{r.identifiers.join(", ")}</dd>
            </div>
          )}
          <div className="dpdp-row">
            <dt>{l.answerTimes}</dt>
            <dd>
              <ul>
                {(["access", "correction", "erasure", "grievance"] as const).map((t) => (
                  <li key={t}>
                    {t === "grievance" ? l.grievances : l.requestTypes[t]}: {days(r.responseWithin[t])}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        </dl>
      )}
    </Section>
  );
}

export type PrivacyCentreSection = "consents" | "data" | "requests" | "nominees" | "contact";

export interface PrivacyCentreProps {
  /** Which parts to show, in order. Default all five. */
  sections?: PrivacyCentreSection[];
  labels?: Partial<Labels>;
  className?: string;
}

/** The whole privacy centre: choices, data, requests, nominees and how to reach you. Each part is also exported on its own. */
export function PrivacyCentre({ sections = ["consents", "data", "requests", "nominees", "contact"], labels, className }: PrivacyCentreProps) {
  const parts: Record<PrivacyCentreSection, ReactNode> = {
    consents: <ConsentSettings key="consents" {...(labels ? { labels } : {})} />,
    data: <MyData key="data" {...(labels ? { labels } : {})} />,
    requests: <Requests key="requests" {...(labels ? { labels } : {})} />,
    nominees: <Nominees key="nominees" {...(labels ? { labels } : {})} />,
    contact: <HowToReachUs key="contact" {...(labels ? { labels } : {})} />,
  };
  return <div className={cx("dpdp-centre", className)}>{sections.map((s) => parts[s])}</div>;
}
