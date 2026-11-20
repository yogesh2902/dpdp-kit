// React hooks over dpdp-kit/client. No DOM here, so React Native uses the same hooks.
import { createContext, createElement, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type ClientOptions, createClient, type DpdpClient } from "../client.js";
import type { AccessSummary, ConsentsResponse, OpenRequestResponse, PersonRequest, PrivacyNotice, PurposeStatus, RightsInfo } from "../http.js";
import type { NoticeLanguage } from "../languages.js";
import type { NoticeKind } from "../notice.js";
import type { Nominee, RequestType } from "../records.js";

/** What a hook's data depends on; a change through one hook reloads the others that show it. */
type Topic = "consents" | "data" | "requests" | "nominees";

interface DpdpContextValue {
  client: DpdpClient<string>;
  subscribe(topic: Topic, reload: () => void): () => void;
  changed(...topics: Topic[]): void;
}

const DpdpContext = createContext<DpdpContextValue | null>(null);

export interface DpdpProviderProps {
  /** A client from `createClient()`. Without one, the provider makes one from `options`. */
  client?: DpdpClient<string>;
  /** For the client the provider makes, once: `base`, `headers`… Default: the API at `/privacy` on the same site. */
  options?: ClientOptions;
  children?: ReactNode;
}

/**
 * Gives the hooks and components below it the API to call.
 *
 * ```tsx
 * <DpdpProvider options={{ base: "/privacy" }}>
 *   <PrivacyCentre />
 * </DpdpProvider>
 * ```
 */
export function DpdpProvider({ client, options, children }: DpdpProviderProps) {
  // Made once: `options` is often an inline object, new on every render.
  const made = useRef<DpdpClient<string> | undefined>(undefined);
  const own = client ?? (made.current ??= createClient(options));
  const listeners = useRef(new Map<Topic, Set<() => void>>());
  const value = useMemo<DpdpContextValue>(
    () => ({
      client: own,
      subscribe(topic, reload) {
        const set = listeners.current.get(topic) ?? new Set();
        listeners.current.set(topic, set);
        set.add(reload);
        return () => set.delete(reload);
      },
      changed(...topics) {
        for (const t of topics) for (const reload of listeners.current.get(t) ?? []) reload();
      },
    }),
    [own],
  );
  return createElement(DpdpContext.Provider, { value }, children);
}

function useDpdpContext(): DpdpContextValue {
  const ctx = useContext(DpdpContext);
  if (!ctx) throw new Error("dpdp-kit/react: wrap your component in <DpdpProvider>");
  return ctx;
}

/** For the components: tell the hooks showing these topics to reload. Not part of the public API. */
export function useChanged(): (...topics: Topic[]) => void {
  return useDpdpContext().changed;
}

/** The client the provider gives, typed with your purposes. */
export function useDpdpClient<P extends string = string>(): DpdpClient<P> {
  return useDpdpContext().client as unknown as DpdpClient<P>;
}

/** What every hook returns: the data once loaded, whether it's loading, the last error, and `reload`. */
export interface Resource<T> {
  data: T | undefined;
  loading: boolean;
  error: unknown;
  reload(): void;
}

/** Loads `load()` when `key` changes, reloads when one of `topics` changes, and ignores stale answers. */
function useResource<T>(key: string, load: () => Promise<T>, topics: readonly Topic[] = []): Resource<T> & { set(data: T): void } {
  const ctx = useDpdpContext();
  const [state, setState] = useState<{ data: T | undefined; loading: boolean; error: unknown }>({ data: undefined, loading: true, error: undefined });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let current = true;
    setState((s) => ({ ...s, loading: true }));
    loadRef.current().then(
      (data) => current && setState({ data, loading: false, error: undefined }),
      (error: unknown) => current && setState((s) => ({ data: s.data, loading: false, error })),
    );
    return () => {
      current = false;
    };
  }, [key, tick]);

  useEffect(() => {
    const offs = topics.map((t) => ctx.subscribe(t, reload));
    return () => {
      for (const off of offs) off();
    };
    // `topics` is fixed for each hook.
  }, [ctx, reload]);

  const set = useCallback((data: T) => setState({ data, loading: false, error: undefined }), []);
  return { ...state, reload, set };
}

/** The privacy notice (Rule 3) in a language. Showing it saves it as proof, on the server. */
export function useNotice(options: { language?: NoticeLanguage; kind?: NoticeKind } = {}): Resource<PrivacyNotice> {
  const { client } = useDpdpContext();
  const { language, kind } = options;
  const { set: _set, ...r } = useResource(`notice:${language ?? ""}:${kind ?? ""}`, () =>
    client.notice({ ...(language ? { language } : {}), ...(kind ? { kind } : {}) }),
  );
  return r;
}

/** The languages the notice is available in, for a language picker. */
export function useNoticeLanguages(): Resource<NoticeLanguage[]> {
  const { client } = useDpdpContext();
  const { set: _set, ...r } = useResource("languages", () => client.languages());
  return r;
}

/** How to make a request, identifiers and answer times (Rule 14(1)). */
export function useRights(): Resource<RightsInfo> {
  const { client } = useDpdpContext();
  const { set: _set, ...r } = useResource("rights", () => client.rights());
  return r;
}

export interface ConsentsState<P extends string> extends Resource<ConsentsResponse<P>> {
  /** Every purpose, with `active`: granted (consent) or not objected to (Section 7(a)). */
  purposes: PurposeStatus<P>[];
  /** Purposes with a change on its way to the server. */
  saving: ReadonlySet<P>;
  grant(purposes: readonly P[], options?: { language?: NoticeLanguage }): Promise<void>;
  withdraw(purposes: readonly P[]): Promise<void>;
  object(purposes: readonly P[]): Promise<void>;
  liftObjection(purposes: readonly P[]): Promise<void>;
  /**
   * Turn a purpose on or off, the way a switch does: grant or withdraw a consent purpose, lift or
   * record an objection to a Section 7(a) use. Other legitimate uses can't be switched.
   */
  set(purpose: P, active: boolean, options?: { language?: NoticeLanguage }): Promise<void>;
}

/**
 * The person's consents and objections, with the actions to change them. Changes show at once and
 * are undone if the server refuses them (the error is in `error`, and the promise rejects).
 */
export function useConsents<P extends string = string>(): ConsentsState<P> {
  const ctx = useDpdpContext();
  const client = ctx.client as unknown as DpdpClient<P>;
  const r = useResource<ConsentsResponse<P>>("consents", () => client.consents(), ["consents"]);
  const [saving, setSaving] = useState<ReadonlySet<P>>(new Set());
  const [failure, setFailure] = useState<unknown>(undefined);
  const latest = useRef(r.data);
  latest.current = r.data;

  const change = useCallback(
    async (purposes: readonly P[], active: boolean, send: () => Promise<unknown>) => {
      const before = latest.current;
      setFailure(undefined);
      if (before) {
        const turn = new Set(purposes);
        const purposesNow = before.purposes.map((p) => (turn.has(p.purpose) ? { ...p, active } : p));
        r.set({
          purposes: purposesNow,
          consents: purposesNow.filter((p) => p.basis === "consent" && p.active).map((p) => p.purpose),
          objections: purposesNow.filter((p) => p.basis === "legitimate-use" && !p.active).map((p) => p.purpose),
        });
      }
      setSaving((s) => new Set([...s, ...purposes]));
      try {
        await send();
        ctx.changed("consents", "data");
      } catch (error) {
        if (before) r.set(before);
        setFailure(error);
        throw error;
      } finally {
        setSaving((s) => new Set([...s].filter((p) => !purposes.includes(p))));
      }
    },
    [ctx, r.set],
  );

  const grant = useCallback((ps: readonly P[], o?: { language?: NoticeLanguage }) => change(ps, true, () => client.grant(ps, o)), [change, client]);
  const withdraw = useCallback((ps: readonly P[]) => change(ps, false, () => client.withdraw(ps)), [change, client]);
  const object = useCallback((ps: readonly P[]) => change(ps, false, () => client.object(ps)), [change, client]);
  const liftObjection = useCallback((ps: readonly P[]) => change(ps, true, () => client.liftObjection(ps)), [change, client]);
  const set = useCallback(
    (purpose: P, active: boolean, o?: { language?: NoticeLanguage }) => {
      const def = latest.current?.purposes.find((p) => p.purpose === purpose);
      if (def?.basis === "legitimate-use") {
        if (def.legitimateUse !== "7(a)") return Promise.reject(new Error(`${purpose} is a legitimate use that can't be switched off`));
        return active ? liftObjection([purpose]) : object([purpose]);
      }
      return active ? grant([purpose], o) : withdraw([purpose]);
    },
    [grant, withdraw, object, liftObjection],
  );

  return {
    data: r.data,
    loading: r.loading,
    error: failure ?? r.error,
    reload: r.reload,
    purposes: r.data?.purposes ?? [],
    saving,
    grant,
    withdraw,
    object,
    liftObjection,
    set,
  };
}

/** What you hold about the person and who it's shared with (Section 11). Reloads after consent changes. */
export function useMyData(): Resource<AccessSummary> {
  const { client } = useDpdpContext();
  const { set: _set, ...r } = useResource("data", () => client.data(), ["data"]);
  return r;
}

export interface RequestsState extends Resource<PersonRequest[]> {
  requests: PersonRequest[];
  /** Open a request; answers with it and the acknowledgement to show the person. */
  open(type: RequestType, details?: Record<string, unknown>): Promise<OpenRequestResponse>;
}

/** The person's rights requests, oldest first, and `open` for a new one. */
export function useRequests(): RequestsState {
  const ctx = useDpdpContext();
  const r = useResource("requests", () => ctx.client.requests(), ["requests"]);
  const open = useCallback(
    async (type: RequestType, details?: Record<string, unknown>) => {
      const answer = await ctx.client.openRequest(type, details);
      ctx.changed("requests");
      return answer;
    },
    [ctx],
  );
  return { data: r.data, loading: r.loading, error: r.error, reload: r.reload, requests: r.data ?? [], open };
}

export interface NomineesState extends Resource<Nominee[]> {
  nominees: Nominee[];
  nominate(nominee: { name: string; contact: string; relation?: string }): Promise<Nominee>;
  revoke(id: string): Promise<void>;
}

/** The person's nominees (Section 14). */
export function useNominees(): NomineesState {
  const ctx = useDpdpContext();
  const r = useResource("nominees", () => ctx.client.nominees(), ["nominees"]);
  const nominate = useCallback(
    async (nominee: { name: string; contact: string; relation?: string }) => {
      const added = await ctx.client.nominate(nominee);
      ctx.changed("nominees", "requests");
      return added;
    },
    [ctx],
  );
  const revoke = useCallback(
    async (id: string) => {
      await ctx.client.revokeNominee(id);
      ctx.changed("nominees");
    },
    [ctx],
  );
  return { data: r.data, loading: r.loading, error: r.error, reload: r.reload, nominees: r.data ?? [], nominate, revoke };
}
