// @vitest-environment jsdom
// dpdp-kit/react-native, rendered through react-native-web (aliased in vitest.config.ts), against the real API.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ConsentNotice, PrivacyCentre } from "../src/react-native/index.js";
import { setup } from "./react-fixture.js";

afterEach(cleanup);

describe("dpdp-kit/react-native", () => {
  it("<ConsentNotice>: the notice's text, every switch off, only what was switched on granted", async () => {
    const { dpdp, wrapper } = setup();
    const done: unknown[] = [];
    render(<ConsentNotice onDone={(r) => done.push(r)} />, { wrapper });
    expect(await screen.findByRole("heading", { name: "Privacy notice: Chai & Co" })).toBeTruthy();
    const offers = screen.getByRole("switch", { name: "Offers by SMS" }) as HTMLInputElement;
    expect(offers.checked).toBe(false);
    expect(screen.getByText("Data used: Mobile number")).toBeTruthy();

    await userEvent.click(offers);
    await userEvent.click(screen.getByRole("button", { name: "Accept selected" }));
    await waitFor(() => expect(done).toEqual([{ granted: ["offers"], language: "en" }]));
    expect((await dpdp.consent.history("u1"))[0]).toMatchObject({ action: "grant", purposes: ["offers"] });
  });

  it("<ConsentNotice>: picks another language", async () => {
    const { dpdp, wrapper } = setup();
    render(<ConsentNotice />, { wrapper });
    await userEvent.click(await screen.findByRole("radio", { name: "हिन्दी" }));
    expect(await screen.findByRole("heading", { name: "Chai & Co की गोपनीयता सूचना" })).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: "एसएमएस से ऑफ़र" }));
    await userEvent.click(screen.getByRole("button", { name: "Accept selected" }));
    await waitFor(async () => expect((await dpdp.consent.history("u1"))[0]).toMatchObject({ language: "hi" }));
  });

  it("<PrivacyCentre>: choices, data, a request and a nominee", async () => {
    const { dpdp, wrapper } = setup();
    render(<PrivacyCentre theme="dark" />, { wrapper });

    await userEvent.click(await screen.findByRole("switch", { name: "Offers by SMS" }));
    await waitFor(async () => expect(await dpdp.consent.active("u1")).toEqual(["offers"]));
    await waitFor(() => expect(screen.getByText("Data used: Mobile number")).toBeTruthy()); // the notice's words beside the switch
    await userEvent.click(screen.getByRole("switch", { name: "SMS receipts" }));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, stop" })); // objecting asks first
    await waitFor(async () => expect(await dpdp.consent.objections("u1")).toEqual(["receipts"]));
    await waitFor(() => expect(screen.getByText("• msg91 (IN)")).toBeTruthy());
    expect(screen.getByText("Mobile number")).toBeTruthy();

    await userEvent.click(screen.getByRole("radio", { name: "Erase my data" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Details (optional)" }), "Please delete my interests");
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(screen.getByText(/Your reference is/)).toBeTruthy());
    expect((await dpdp.rights.list({ subjectId: "u1" }))[0]).toMatchObject({ type: "erasure", details: { note: "Please delete my interests" } });

    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Ravi");
    await userEvent.type(screen.getByRole("textbox", { name: "Email or phone" }), "ravi@example.in");
    await userEvent.click(screen.getByRole("button", { name: "Add nominee" }));
    await waitFor(async () => expect((await dpdp.rights.nominees("u1")).map((n) => n.name)).toEqual(["Ravi"]));
    expect(within(document.body).getByText(/within 90 days/)).toBeTruthy();
  });
});
