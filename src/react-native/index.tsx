// dpdp-kit/react-native: the consent notice and privacy centre for React Native and Expo, on the
// same hooks as dpdp-kit/react. Built from View, Text, Switch, Pressable and TextInput.
import { type ReactNode, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput, useColorScheme, View } from "react-native";
import type { NoticeLanguage } from "../languages.js";
import type { NoticeKind } from "../notice.js";
import type { RequestType } from "../records.js";
import { useChanged, useConsents, useDpdpClient, useMyData, useNominees, useNotice, useNoticeLanguages, useRequests, useRights } from "../react/hooks.js";
import { DEFAULT_LABELS, type Labels } from "../react/labels.js";
import { answerTime, fieldLabel, languageName, noticeParts, show, splitLinks, switchable } from "../react/shared.js";

export {
  type ConsentsState,
  DpdpProvider,
  type DpdpProviderProps,
  type NomineesState,
  type RequestsState,
  type Resource,
  useConsents,
  useDpdpClient,
  useMyData,
  useNominees,
  useNotice,
  useNoticeLanguages,
  useRequests,
  useRights,
} from "../react/hooks.js";
export { DEFAULT_LABELS, type Labels } from "../react/labels.js";
export { createClient, DpdpClientError } from "../client.js";
export type * from "../client.js";

/** The colours the screens use. Pass some in `colors` to change them. */
export interface Colors {
  text: string;
  muted: string;
  background: string;
  surface: string;
  border: string;
  accent: string;
  off: string;
  error: string;
}

export const LIGHT: Colors = { text: "#1f1d1a", muted: "#6b665e", background: "#ffffff", surface: "#f6f4f0", border: "#e2ded6", accent: "#b4532a", off: "#857e73", error: "#b42318" };
export const DARK: Colors = { text: "#f1ede6", muted: "#aaa398", background: "#1b1a18", surface: "#25231f", border: "#3a3731", accent: "#e0855a", off: "#8a8378", error: "#f97066" };

/** Props every screen takes. */
export interface ScreenProps {
  labels?: Partial<Labels>;
  /** `"auto"` follows the phone's setting. Default `"light"`. */
  theme?: "light" | "dark" | "auto";
  colors?: Partial<Colors>;
}

function useLook({ labels, theme = "light", colors }: ScreenProps) {
  const system = useColorScheme();
  const dark = theme === "dark" || (theme === "auto" && system === "dark");
  // Keyed by the colour values, so an inline `colors={{ … }}` doesn't rebuild the styles on every render.
  const key = JSON.stringify(colors ?? {});
  const c = useMemo(() => ({ ...(dark ? DARK : LIGHT), ...colors }), [dark, key]);
  const s = useMemo(() => makeStyles(c), [c]);
  return { l: { ...DEFAULT_LABELS, ...labels }, c, s };
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    screen: { backgroundColor: c.background },
    content: { padding: 16, gap: 16 },
    card: { borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 16, gap: 10, backgroundColor: c.background },
    title: { fontSize: 20, fontWeight: "700", color: c.text },
    heading: { fontSize: 18, fontWeight: "700", color: c.text },
    subheading: { fontSize: 15, fontWeight: "700", color: c.text, marginTop: 6 },
    intro: { fontSize: 15, lineHeight: 22, color: c.muted },
    small: { fontSize: 13, lineHeight: 19, color: c.muted },
    text: { fontSize: 15, lineHeight: 22, color: c.text },
    link: { color: c.accent, textDecorationLine: "underline" },
    purpose: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 8, backgroundColor: c.surface },
    purposeText: { flex: 1, gap: 2 },
    purposeName: { fontSize: 15, fontWeight: "600", color: c.text },
    actions: { gap: 10, marginTop: 6 },
    button: { borderWidth: 1.5, borderColor: c.text, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 18, alignItems: "center" },
    buttonText: { fontSize: 15, fontWeight: "600", color: c.text },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: { borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12 },
    chipOn: { backgroundColor: c.accent, borderColor: c.accent },
    chipText: { fontSize: 14, color: c.text },
    chipTextOn: { color: c.background },
    row: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, gap: 2 },
    label: { fontSize: 13, fontWeight: "600", color: c.text },
    input: { borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, fontSize: 15, color: c.text },
    item: { padding: 12, borderRadius: 8, backgroundColor: c.surface, gap: 2 },
    itemRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
    error: { fontSize: 14, color: c.error },
    disabled: { opacity: 0.6 },
  });
}
type Styles = ReturnType<typeof makeStyles>;

/** A line of text with its URLs opening in the browser. */
function Linked({ text, s, style }: { text: string; s: Styles; style: object }) {
  return (
    <Text style={style}>
      {splitLinks(text).map((p, i) =>
        p.url ? (
          <Text key={i} style={s.link} accessibilityRole="link" onPress={() => Linking.openURL(p.text).catch(() => {})}>
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </Text>
  );
}

function Button({ label, onPress, disabled, s }: { label: string; onPress(): void; disabled?: boolean; s: Styles }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={[s.button, disabled ? s.disabled : null]}>
      <Text style={s.buttonText}>{label}</Text>
    </Pressable>
  );
}

function Chips<T extends string>({ options, value, onChange, label, s }: { options: Array<{ value: T; label: string }>; value: T; onChange(v: T): void; label: string; s: Styles }) {
  return (
    <View style={s.chips} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => onChange(o.value)} style={[s.chip, on ? s.chipOn : null]}>
            <Text style={[s.chipText, on ? s.chipTextOn : null]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Status({ loading, error, retry, l, s }: { loading: boolean; error: unknown; retry(): void; l: Labels; s: Styles }) {
  if (error) {
    return (
      <View accessibilityRole="alert" style={s.chips}>
        <Text style={s.error}>{l.failed}</Text>
        <Text style={s.link} accessibilityRole="button" onPress={retry}>
          {l.retry}
        </Text>
      </View>
    );
  }
  return loading ? <Text style={s.small}>{l.loading}</Text> : null;
}

function Live({ text, error, s }: { text: string; error?: boolean; s: Styles }) {
  return (
    <Text accessibilityLiveRegion="polite" accessibilityRole={error ? "alert" : "text"} style={error ? s.error : s.small}>
      {text}
    </Text>
  );
}

function Scroll({ scroll, s, children }: { scroll: boolean; s: Styles; children: ReactNode }) {
  return scroll ? (
    <ScrollView style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  ) : (
    <View style={s.content}>{children}</View>
  );
}

/** Languages the notice is in, as buttons, each in its own script. Nothing when there's only English. */
export function LanguagePicker({ value, onChange, ...look }: ScreenProps & { value: NoticeLanguage; onChange(language: NoticeLanguage): void }) {
  const { l, s } = useLook(look);
  const { data } = useNoticeLanguages();
  if (!data || data.length < 2) return null;
  return <Chips label={l.language} value={value} onChange={onChange} s={s} options={data.map((code) => ({ value: code, label: languageName(code) }))} />;
}

export interface ConsentNoticeProps<P extends string = string> extends ScreenProps {
  /** The language to start in. Default English. */
  language?: NoticeLanguage;
  /** `"existing-users"` shows the notice without choices. */
  kind?: NoticeKind;
  onDone?(result: { granted: P[]; language: NoticeLanguage }): void;
  /** Wrap in a ScrollView. Default true; pass false inside your own. */
  scroll?: boolean;
}

/**
 * The consent request with the notice (Section 5, Rule 3, Section 6): the notice's own text in the
 * person's language, a switch per purpose, every one off to start with, and "Accept selected" and
 * "Reject all" alike.
 */
export function ConsentNotice<P extends string = string>({ language: initial = "en", kind = "consent", onDone, scroll = true, ...look }: ConsentNoticeProps<P>) {
  const { l, c, s } = useLook(look);
  const [language, setLanguage] = useState<NoticeLanguage>(initial);
  const notice = useNotice({ language, kind });
  const client = useDpdpClient<P>();
  const changed = useChanged();
  const [chosen, setChosen] = useState<ReadonlySet<P>>(new Set());
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const parts = notice.data ? noticeParts(notice.data) : undefined;

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
    <Scroll scroll={scroll} s={s}>
      <View style={s.card}>
        <LanguagePicker value={language} onChange={setLanguage} {...look} />
        <Status loading={notice.loading && !parts} error={notice.error} retry={notice.reload} l={l} s={s} />
        {parts && (
          <>
            <Text style={s.title} accessibilityRole="header">
              {parts.title}
            </Text>
            {parts.intro.map((line, i) => (
              <Linked key={i} text={line} s={s} style={s.intro} />
            ))}
            {parts.items.map(({ purpose: key, text, data }) => {
              const purpose = key as P;
              const on = chosen.has(purpose);
              return (
                <View key={purpose} style={s.purpose}>
                  <View style={s.purposeText}>
                    <Text style={s.purposeName}>{text}</Text>
                    <Text style={s.small}>{data}</Text>
                  </View>
                  {kind === "consent" && (
                    <Switch
                      accessibilityLabel={text}
                      accessibilityHint={data}
                      value={on}
                      disabled={state === "saving"}
                      trackColor={{ false: c.off, true: c.accent }}
                      thumbColor="#ffffff"
                      ios_backgroundColor={c.off}
                      onValueChange={(next) => setChosen((set) => (next ? new Set([...set, purpose]) : new Set([...set].filter((p) => p !== purpose))))}
                    />
                  )}
                </View>
              );
            })}
            {parts.footer.map((line, i) => (
              <Linked key={i} text={line} s={s} style={s.small} />
            ))}
            {state === "failed" && <Live text={l.notSaved} error s={s} />}
            <View style={s.actions}>
              {kind === "consent" ? (
                <>
                  <Button label={l.rejectAll} disabled={state === "saving"} onPress={() => finish([])} s={s} />
                  <Button
                    label={l.acceptSelected}
                    disabled={state === "saving"}
                    onPress={() => finish(parts.items.map((i) => i.purpose as P).filter((p) => chosen.has(p)))}
                    s={s}
                  />
                </>
              ) : (
                <Button label={l.continue} onPress={() => finish([])} s={s} />
              )}
            </View>
          </>
        )}
      </View>
    </Scroll>
  );
}

function Card({ heading, intro, s, children }: { heading: string; intro?: string; s: Styles; children: ReactNode }) {
  return (
    <View style={s.card}>
      <Text style={s.heading} accessibilityRole="header">
        {heading}
      </Text>
      {intro ? <Text style={s.intro}>{intro}</Text> : null}
      {children}
    </View>
  );
}

/**
 * Consents and Section 7(a) objections as switches; withdrawing is as easy as granting (Section 6(4)).
 * Each consent purpose shows the notice's own words and data, with the full notice a tap away, so a
 * consent given here is accompanied by the notice (Section 5(1)) and recorded against it. Objecting
 * asks for confirmation first.
 */
export function ConsentSettings({ language: initial = "en", ...look }: ScreenProps & { language?: NoticeLanguage }) {
  const { l, c, s } = useLook(look);
  const consents = useConsents();
  const [language, setLanguage] = useState<NoticeLanguage>(initial);
  const notice = useNotice({ language });
  const parts = notice.data ? noticeParts(notice.data) : undefined;
  const [said, setSaid] = useState<"" | "saved" | "failed">("");
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  const [showNotice, setShowNotice] = useState(false);
  const choices = consents.purposes.filter(switchable);
  const fixed = consents.purposes.filter((p) => !switchable(p));

  const change = (purpose: string, on: boolean) => {
    setSaid("");
    setConfirming(undefined);
    consents.set(purpose, on, { language }).then(
      () => setSaid("saved"),
      () => setSaid("failed"),
    );
  };

  return (
    <Card heading={l.consentsHeading} intro={l.consentsIntro} s={s}>
      <LanguagePicker value={language} onChange={setLanguage} {...look} />
      <Status loading={consents.loading && !consents.data} error={!consents.data && consents.error} retry={consents.reload} l={l} s={s} />
      {choices.map((p) => {
        const item = p.basis === "consent" ? parts?.items.find((x) => x.purpose === p.purpose) : undefined;
        const name = item?.text ?? p.description ?? p.purpose;
        return (
          <View key={p.purpose} style={s.purpose}>
            <View style={s.purposeText}>
              <Text style={s.purposeName}>{name}</Text>
              {item?.data ? <Text style={s.small}>{item.data}</Text> : null}
              {confirming === p.purpose && (
                <View accessibilityRole="alert" style={{ gap: 6, marginTop: 4 }}>
                  <Text style={s.text}>{l.confirmObjection(name)}</Text>
                  <View style={s.chips}>
                    <Text style={s.link} accessibilityRole="button" onPress={() => change(p.purpose, false)}>
                      {l.confirm}
                    </Text>
                    <Text style={s.link} accessibilityRole="button" onPress={() => setConfirming(undefined)}>
                      {l.cancel}
                    </Text>
                  </View>
                </View>
              )}
            </View>
            <Switch
              accessibilityLabel={name}
              {...(item?.data ? { accessibilityHint: item.data } : {})}
              value={p.active}
              disabled={consents.saving.has(p.purpose)}
              trackColor={{ false: c.off, true: c.accent }}
              thumbColor="#ffffff"
              ios_backgroundColor={c.off}
              onValueChange={(on) => (p.basis === "legitimate-use" && !on ? setConfirming(p.purpose) : change(p.purpose, on))}
            />
          </View>
        );
      })}
      {parts && (
        <View style={{ gap: 6 }}>
          <Text style={s.link} accessibilityRole="button" accessibilityState={{ expanded: showNotice }} onPress={() => setShowNotice((v) => !v)}>
            {l.readNotice}
          </Text>
          {showNotice &&
            [parts.title, ...parts.intro, ...parts.items.map((x) => `${x.text}. ${x.data}`), ...parts.footer].map((line, k) => (
              <Linked key={k} text={line} s={s} style={k === 0 ? s.subheading : s.small} />
            ))}
        </View>
      )}
      {fixed.length > 0 && (
        <View>
          <Text style={s.small}>{l.alwaysOnIntro}</Text>
          {fixed.map((p) => (
            <Text key={p.purpose} style={s.small}>
              • {p.description ?? p.purpose}
            </Text>
          ))}
        </View>
      )}
      <Live text={said === "saved" ? l.saved : said === "failed" ? l.notSaved : ""} error={said === "failed"} s={s} />
    </Card>
  );
}

/** What you hold and who you share it with (Section 11), with a copy to share or save. */
export function MyData(look: ScreenProps) {
  const { l, s } = useLook(look);
  const summary = useMyData();
  const d = summary.data;
  const held = d?.data.filter((t) => t.rows.length > 0) ?? [];
  return (
    <Card heading={l.dataHeading} intro={l.dataIntro} s={s}>
      <Status loading={summary.loading && !d} error={!d && summary.error} retry={summary.reload} l={l} s={s} />
      {d && (
        <>
          {held.length === 0 && <Text style={s.text}>{l.noData}</Text>}
          {held.map((t) =>
            t.rows.map((row, r) =>
              Object.entries(row).map(([field, value]) => (
                <View key={`${t.key}-${r}-${field}`} style={s.row}>
                  <Text style={s.small}>{fieldLabel(t.fields, field)}</Text>
                  <Text style={s.text}>{show(value)}</Text>
                </View>
              )),
            ),
          )}
          <Text style={s.subheading} accessibilityRole="header">
            {l.sharedWith}
          </Text>
          {d.sharedWith.length === 0 ? (
            <Text style={s.text}>{l.sharedWithNobody}</Text>
          ) : (
            d.sharedWith.map((p) => (
              <Text key={p.name} style={s.text}>
                • {p.description ?? p.name}
                {p.countries?.length ? ` (${p.countries.join(", ")})` : ""}
              </Text>
            ))
          )}
          <Button label={l.download} onPress={() => Share.share({ title: l.download, message: JSON.stringify(d, null, 2) })} s={s} />
        </>
      )}
    </Card>
  );
}

/** The person's requests, and a form to make one; the acknowledgement shows once it's sent. */
export function Requests({ types = ["access", "correction", "erasure", "grievance"], ...look }: ScreenProps & { types?: RequestType[] }) {
  const { l, c, s } = useLook(look);
  const requests = useRequests();
  const [type, setType] = useState<RequestType>(types[0] ?? "access");
  const [details, setDetails] = useState("");
  const [ack, setAck] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const date = new Intl.DateTimeFormat(l.locale, { dateStyle: "medium", timeZone: "Asia/Kolkata" });

  async function submit() {
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
    <Card heading={l.requestsHeading} intro={l.requestsIntro} s={s}>
      <Text style={s.label}>{l.requestType}</Text>
      <Chips<RequestType> label={l.requestType} value={type} onChange={setType} s={s} options={types.map((t) => ({ value: t, label: l.requestTypes[t] }))} />
      <Text style={s.label}>{l.requestDetails}</Text>
      <TextInput
        accessibilityLabel={l.requestDetails}
        style={[s.input, { minHeight: 72, textAlignVertical: "top" }]}
        multiline
        maxLength={2000}
        value={details}
        onChangeText={setDetails}
        placeholderTextColor={c.muted}
      />
      <Button label={l.sendRequest} disabled={state === "saving"} onPress={submit} s={s} />
      <Live text={state === "failed" ? l.notSaved : ack} error={state === "failed"} s={s} />
      <Status loading={requests.loading && !requests.data} error={!requests.data && requests.error} retry={requests.reload} l={l} s={s} />
      {requests.data && requests.requests.length === 0 && <Text style={s.text}>{l.noRequests}</Text>}
      {[...requests.requests].reverse().map((r) => (
        <View key={r.id} style={s.item}>
          <View style={s.itemRow}>
            <Text style={s.purposeName}>{l.requestTypes[r.type]}</Text>
            <Text style={[s.label, r.status === "open" ? { color: c.accent } : null]}>{l.statuses[r.status]}</Text>
          </View>
          <Text style={s.small}>
            {l.opened} {date.format(new Date(r.openedAt))}
            {r.status === "open" ? ` · ${l.due} ${date.format(new Date(r.dueAt))}` : ""}
          </Text>
          <Text style={s.small} selectable>
            {r.id}
          </Text>
        </View>
      ))}
    </Card>
  );
}

/** Nominees (Section 14, Rule 14(4)): add and remove. */
export function Nominees(look: ScreenProps) {
  const { l, c, s } = useLook(look);
  const nominees = useNominees();
  const [form, setForm] = useState({ name: "", contact: "", relation: "" });
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");

  async function submit() {
    if (!form.name.trim() || !form.contact.trim()) return;
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
    <Card heading={l.nomineesHeading} intro={l.nomineesIntro} s={s}>
      <Status loading={nominees.loading && !nominees.data} error={!nominees.data && nominees.error} retry={nominees.reload} l={l} s={s} />
      {nominees.data && nominees.nominees.length === 0 && <Text style={s.text}>{l.noNominees}</Text>}
      {nominees.nominees.map((n) => (
        <View key={n.id} style={[s.item, s.itemRow]}>
          <Text style={[s.text, { flex: 1 }]}>
            {n.name}
            {n.relation ? ` (${n.relation})` : ""} · {n.contact}
          </Text>
          <Text style={s.link} accessibilityRole="button" accessibilityLabel={`${l.remove} ${n.name}`} onPress={() => nominees.revoke(n.id).catch(() => setState("failed"))}>
            {l.remove}
          </Text>
        </View>
      ))}
      {(["name", "contact", "relation"] as const).map((k) => {
        const label = k === "name" ? l.nomineeName : k === "contact" ? l.nomineeContact : l.nomineeRelation;
        return (
          <View key={k} style={{ gap: 4 }}>
            <Text style={s.label}>{label}</Text>
            <TextInput
              accessibilityLabel={label}
              style={s.input}
              value={form[k]}
              maxLength={200}
              autoCapitalize={k === "contact" ? "none" : "words"}
              {...(k === "contact" ? { keyboardType: "email-address" as const } : {})}
              onChangeText={(v) => setForm({ ...form, [k]: v })}
              placeholderTextColor={c.muted}
            />
          </View>
        );
      })}
      <Button label={l.addNominee} disabled={state === "saving" || !form.name.trim() || !form.contact.trim()} onPress={submit} s={s} />
      <Live text={state === "failed" ? l.notSaved : ""} error={state === "failed"} s={s} />
    </Card>
  );
}

/** How to make a request, identifiers and answer times (Rule 14(1), (3)). */
export function HowToReachUs(look: ScreenProps) {
  const { l, s } = useLook(look);
  const rights = useRights();
  const r = rights.data;
  const rows: Array<[string, string]> = r
    ? [
        ...(r.how ? ([[l.howToAsk, r.how]] as Array<[string, string]>) : []),
        ...(r.contact ? ([[l.contact, r.contact]] as Array<[string, string]>) : []),
        ...(r.identifiers.length ? ([[l.identifiers, r.identifiers.join(", ")]] as Array<[string, string]>) : []),
        [
          l.answerTimes,
          (["access", "correction", "erasure", "grievance"] as const)
            .map((t) => `${t === "grievance" ? l.grievances : l.requestTypes[t]}: ${answerTime(l, r.responseWithin[t])}`)
            .join("\n"),
        ],
      ]
    : [];
  return (
    <Card heading={l.contactHeading} s={s}>
      <Status loading={rights.loading && !r} error={!r && rights.error} retry={rights.reload} l={l} s={s} />
      {rows.map(([k, v]) => (
        <View key={k} style={s.row}>
          <Text style={s.small}>{k}</Text>
          <Linked text={v} s={s} style={s.text} />
        </View>
      ))}
    </Card>
  );
}

export type PrivacyCentreSection = "consents" | "data" | "requests" | "nominees" | "contact";

export interface PrivacyCentreProps extends ScreenProps {
  /** The notice language to start in for the consent choices. Default English. */
  language?: NoticeLanguage;
  sections?: PrivacyCentreSection[];
  /** Wrap in a ScrollView. Default true; pass false inside your own. */
  scroll?: boolean;
}

/** The whole privacy centre. Each part is also exported on its own. */
export function PrivacyCentre({ sections = ["consents", "data", "requests", "nominees", "contact"], scroll = true, language, ...look }: PrivacyCentreProps) {
  const { s } = useLook(look);
  const parts: Record<PrivacyCentreSection, ReactNode> = {
    consents: <ConsentSettings key="consents" {...look} {...(language ? { language } : {})} />,
    data: <MyData key="data" {...look} />,
    requests: <Requests key="requests" {...look} />,
    nominees: <Nominees key="nominees" {...look} />,
    contact: <HowToReachUs key="contact" {...look} />,
  };
  return (
    <Scroll scroll={scroll} s={s}>
      {sections.map((p) => parts[p])}
    </Scroll>
  );
}
