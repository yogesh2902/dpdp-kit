// @vitest-environment jsdom
// dpdp-kit/react hooks in a browser-like DOM, against the real HTTP API through the Next.js handlers.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  useConsents,
  useMyData,
  useNominees,
  useNotice,
  useNoticeLanguages,
  useRequests,
  useRights,
} from "../src/react/index.js";
import { type Purpose, setup } from "./react-fixture.js";

describe("dpdp-kit/react hooks", () => {
  it("needs a provider", () => {
    expect(() => renderHook(() => useRights())).toThrow(/wrap your component in <DpdpProvider>/);
  });

  it("switches consents on and off, and reloads the data summary that depends on them", async () => {
    const { dpdp, wrapper } = setup();
    const { result } = renderHook(() => ({ consents: useConsents<Purpose>(), data: useMyData() }), { wrapper });
    await waitFor(() => expect(result.current.consents.loading).toBe(false));
    expect(result.current.consents.purposes.map((p) => [p.purpose, p.active])).toEqual([
      ["account", true],
      ["receipts", true],
      ["offers", false],
    ]);
    await waitFor(() => expect(result.current.data.data?.sharedWith).toEqual([]));

    await act(() => result.current.consents.set("offers", true));
    expect(await dpdp.consent.active("u1")).toEqual(["offers"]);
    // Granting offers shares the phone with msg91, so the summary reloads to say so.
    await waitFor(() => expect(result.current.data.data?.sharedWith.map((s) => s.name)).toEqual(["msg91"]));

    await act(() => result.current.consents.set("receipts", false)); // a 7(a) use: an objection
    expect(await dpdp.consent.objections("u1")).toEqual(["receipts"]);
    expect(result.current.consents.data?.objections).toEqual(["receipts"]);
    await expect(result.current.consents.set("account", false)).rejects.toThrow(/can't be switched off/);
  });

  it("shows a change at once, and undoes it when the server refuses", async () => {
    const { control, wrapper } = setup();
    const { result } = renderHook(() => useConsents<Purpose>(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let release!: () => void;
    control.hold = new Promise((r) => (release = r));
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.set("offers", true);
    });
    expect(result.current.purposes.find((p) => p.purpose === "offers")?.active).toBe(true); // before the server answers
    expect(result.current.saving.has("offers")).toBe(true);
    control.refuse = true;
    control.hold = undefined;
    release();
    await act(() => expect(saving).rejects.toMatchObject({ status: 429, code: "too-many-requests" }));
    expect(result.current.purposes.find((p) => p.purpose === "offers")?.active).toBe(false);
    expect(result.current.error).toMatchObject({ code: "too-many-requests" });
    expect(result.current.saving.size).toBe(0);
  });

  it("undoes only the change that failed when changes overlap", async () => {
    const { control, dpdp, wrapper } = setup();
    const { result } = renderHook(() => useConsents<Purpose>(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let release!: () => void;
    control.holdNextWrite = new Promise((r) => (release = r));
    let first!: Promise<void>;
    act(() => {
      first = result.current.set("offers", true); // held, then refused
    });
    await act(() => result.current.set("receipts", false)); // goes through meanwhile
    control.refuse = true;
    release();
    await act(() => expect(first).rejects.toMatchObject({ code: "too-many-requests" }));
    const active = Object.fromEntries(result.current.purposes.map((p) => [p.purpose, p.active]));
    expect(active).toMatchObject({ offers: false, receipts: false }); // the objection stays shown
    expect(await dpdp.consent.objections("u1")).toEqual(["receipts"]);
  });

  it("loads the notice in the language asked for, keeping only the latest answer", async () => {
    const { control, wrapper } = setup();
    const { result: langs } = renderHook(() => useNoticeLanguages(), { wrapper });
    await waitFor(() => expect(langs.current.data).toEqual(["en", "hi"]));

    let release!: () => void;
    control.hold = new Promise((r) => (release = r));
    const { result, rerender } = renderHook(({ language }: { language: "en" | "hi" }) => useNotice({ language }), { wrapper, initialProps: { language: "en" } });
    control.hold = undefined;
    rerender({ language: "hi" }); // asked before the English answer arrives
    await waitFor(() => expect(result.current.data?.language).toBe("hi"));
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.data?.language).toBe("hi"); // the late English answer is ignored
    expect(result.current.data?.items[0]?.description).toBe("एसएमएस से ऑफ़र");
  });

  it("opens requests and keeps nominees, reloading the lists", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => ({ requests: useRequests(), nominees: useNominees(), rights: useRights() }), { wrapper });
    await waitFor(() => expect(result.current.requests.loading).toBe(false));
    expect(result.current.rights.data?.how).toBe("Settings → Privacy");

    let ack = "";
    await act(async () => {
      ack = (await result.current.requests.open("access")).acknowledgement.text;
    });
    expect(ack).toMatch(/Your reference is/);
    await waitFor(() => expect(result.current.requests.requests.map((r) => r.type)).toEqual(["access"]));

    await act(async () => {
      await result.current.nominees.nominate({ name: "Ravi", contact: "ravi@example.in" });
    });
    await waitFor(() => expect(result.current.nominees.nominees.map((n) => n.name)).toEqual(["Ravi"]));
    // A nomination is recorded as a (resolved) request, so the requests list reloads too.
    await waitFor(() => expect(result.current.requests.requests.map((r) => r.type)).toEqual(["access", "nomination"]));
    await act(() => result.current.nominees.revoke(result.current.nominees.nominees[0]!.id));
    await waitFor(() => expect(result.current.nominees.nominees).toEqual([]));
  });
});
