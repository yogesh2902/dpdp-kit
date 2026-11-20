"use client";
// Sign-up: the account first, then the consent request with the notice (Section 5, 6, Rule 3).
// Every purpose starts switched off; "Accept selected" and "Reject all" look the same.
import { ConsentNotice, DpdpProvider } from "dpdp-kit/react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

export default function SignUp() {
  const router = useRouter();
  const [signedUp, setSignedUp] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch("/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
    if (res.ok) setSignedUp(true); // the response set the demo's sign-in cookie
    else setError("Couldn't create your account. Please try again.");
  }

  if (signedUp) {
    return (
      <DpdpProvider options={{ base: "/privacy" }}>
        <h1>One more thing</h1>
        <p className="lede">Choose what we may use your details for. You can change this at any time.</p>
        <ConsentNotice onDone={() => router.push("/privacy")} />
      </DpdpProvider>
    );
  }
  return (
    <>
      <h1>Create your account</h1>
      <p className="lede">Teas from Assam to the Nilgiris, delivered.</p>
      <form className="signup" onSubmit={submit}>
        <label>Name<input name="name" required autoComplete="name" /></label>
        <label>Mobile number<input name="phone" required inputMode="tel" autoComplete="tel" /></label>
        <label>Email<input name="email" type="email" required autoComplete="email" /></label>
        <label>City<input name="city" autoComplete="address-level2" /></label>
        <button type="submit">Create account</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </>
  );
}
