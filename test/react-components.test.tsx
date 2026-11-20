// @vitest-environment jsdom
// The ready-made screens, driven the way a person would (Testing Library + user-event), against
// the real HTTP API, with an axe-core accessibility check on each.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { ConsentNotice, PrivacyCentre } from "../src/react/index.js";
import { setup } from "./react-fixture.js";

afterEach(cleanup);

async function noViolations(container: Element) {
  // jsdom can't compute colours, so contrast is checked in the browser instead.
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

describe("<ConsentNotice>", () => {
  it("shows the notice's own text with every purpose off, and records only what was switched on", async () => {
    const { dpdp, wrapper } = setup();
    const done: unknown[] = [];
    const { container } = render(<ConsentNotice onDone={(r) => done.push(r)} />, { wrapper });
    const title = await screen.findByRole("heading", { name: "Privacy notice: Chai & Co" });
    expect(title).toBeTruthy();

    const offers = screen.getByRole("switch", { name: "Offers by SMS" });
    expect(offers.getAttribute("aria-checked")).toBe("false"); // off until the person turns it on
    expect(offers.getAttribute("aria-describedby")).toBeTruthy();
    expect(container.textContent).toContain("Data used: Mobile number");
    expect(container.querySelector('a[href="https://chai.example/privacy"]')).toBeTruthy();
    // Both choices are the same kind of button: neither is pushed.
    const accept = screen.getByRole("button", { name: "Accept selected" });
    const reject = screen.getByRole("button", { name: "Reject all" });
    expect(accept.className).toBe(reject.className);
    await noViolations(container);

    await userEvent.click(offers);
    expect(offers.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(accept);
    await waitFor(() => expect(done).toEqual([{ granted: ["offers"], language: "en" }]));
    const [event] = await dpdp.consent.history("u1");
    expect(event).toMatchObject({ action: "grant", purposes: ["offers"], language: "en" });
    expect((await dpdp.notice.get(event!.noticeVersion!))?.notice.text.split("\n")[0]).toBe("Privacy notice: Chai & Co");
  });

  it("records nothing for Reject all", async () => {
    const { dpdp, wrapper } = setup();
    const done: unknown[] = [];
    render(<ConsentNotice onDone={(r) => done.push(r)} />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: "Reject all" }));
    expect(done).toEqual([{ granted: [], language: "en" }]);
    expect(await dpdp.consent.history("u1")).toEqual([]);
  });

  it("switches to another language, and records the grant against that notice", async () => {
    const { dpdp, wrapper } = setup();
    render(<ConsentNotice />, { wrapper });
    const picker = await screen.findByRole("combobox", { name: "Language" });
    expect(within(picker).getAllByRole("option").map((o) => o.getAttribute("value"))).toEqual(["en", "hi"]);
    await userEvent.selectOptions(picker, "hi");
    await screen.findByRole("heading", { name: "Chai & Co की गोपनीयता सूचना" });
    await userEvent.click(screen.getByRole("switch", { name: "एसएमएस से ऑफ़र" }));
    await userEvent.click(screen.getByRole("button", { name: "Accept selected" }));
    await waitFor(async () => expect((await dpdp.consent.history("u1"))[0]).toMatchObject({ language: "hi" }));
  });

  it("says when the choice couldn't be saved, and lets the person try again", async () => {
    const { control, wrapper } = setup();
    const done: unknown[] = [];
    render(<ConsentNotice onDone={(r) => done.push(r)} />, { wrapper });
    await userEvent.click(await screen.findByRole("switch", { name: "Offers by SMS" }));
    control.refuse = true;
    await userEvent.click(screen.getByRole("button", { name: "Accept selected" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't save/);
    expect(done).toEqual([]);
    control.refuse = false;
    await userEvent.click(screen.getByRole("button", { name: "Accept selected" }));
    await waitFor(() => expect(done).toHaveLength(1));
  });
});

describe("<PrivacyCentre>", () => {
  it("lets the person change choices, see their data, make a request and name a nominee", async () => {
    const { dpdp, wrapper } = setup();
    const { container } = render(<PrivacyCentre />, { wrapper });

    // Choices: offers (consent) off, receipts (7(a)) on; account is always on and has no switch.
    const offers = await screen.findByRole("switch", { name: "Offers by SMS" });
    const receipts = screen.getByRole("switch", { name: "SMS receipts" });
    expect([offers.getAttribute("aria-checked"), receipts.getAttribute("aria-checked")]).toEqual(["false", "true"]);
    expect(screen.queryByRole("switch", { name: "account" })).toBeNull();
    expect(container.querySelector(".dpdp-always-on")?.textContent).toContain("account");

    await userEvent.click(offers);
    await waitFor(() => expect(screen.getAllByRole("status").some((s) => s.textContent === "Saved.")).toBe(true));
    expect(await dpdp.consent.active("u1")).toEqual(["offers"]);
    await userEvent.click(receipts);
    await waitFor(async () => expect(await dpdp.consent.objections("u1")).toEqual(["receipts"]));

    // Data: the rows, and msg91 now that offers are on.
    const data = screen.getByRole("region", { name: "Your data" });
    await waitFor(() => expect(within(data).getByText("msg91 (IN)")).toBeTruthy());
    expect(within(data).getByText("98xxxxxx01")).toBeTruthy();
    expect(within(data).getByText("Mobile number")).toBeTruthy(); // the field's label, not its name

    // A request, with the acknowledgement read out.
    const requests = screen.getByRole("region", { name: "Your requests" });
    await userEvent.selectOptions(within(requests).getByRole("combobox", { name: "What do you need?" }), "correction");
    await userEvent.type(within(requests).getByRole("textbox", { name: "Details (optional)" }), "New number");
    await userEvent.click(within(requests).getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(within(requests).getByRole("status").textContent).toMatch(/Your reference is/));
    await waitFor(() => expect(requests.querySelector(".dpdp-request-type")?.textContent).toBe("Correct or update my data"));
    expect((await dpdp.rights.list({ subjectId: "u1" }))[0]?.details).toEqual({ note: "New number" });

    // A nominee, added and removed.
    const nominees = screen.getByRole("region", { name: "Your nominee" });
    await userEvent.type(within(nominees).getByRole("textbox", { name: "Name" }), "Ravi");
    await userEvent.type(within(nominees).getByRole("textbox", { name: "Email or phone" }), "ravi@example.in");
    await userEvent.click(within(nominees).getByRole("button", { name: "Add nominee" }));
    await userEvent.click(await within(nominees).findByRole("button", { name: "Remove Ravi" }));
    await waitFor(() => expect(within(nominees).getByText("You haven't named anyone.")).toBeTruthy());

    // How to reach us.
    const contact = screen.getByRole("region", { name: "How to reach us" });
    await waitFor(() => expect(within(contact).getByText("Settings → Privacy")).toBeTruthy());
    expect(contact.textContent).toContain("within 90 days");

    await noViolations(container);
  });

  it("shows only the sections asked for, with your own words", async () => {
    const { wrapper } = setup();
    render(<PrivacyCentre sections={["consents"]} labels={{ consentsHeading: "आपकी पसंद" }} />, { wrapper });
    expect(await screen.findByRole("heading", { name: "आपकी पसंद" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Your data" })).toBeNull();
  });
});
