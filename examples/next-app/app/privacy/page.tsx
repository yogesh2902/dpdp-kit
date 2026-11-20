// The privacy centre: choices, data, requests, nominees and how to reach us, from dpdp-kit/react.
import { cookies } from "next/headers";
import { PrivacyCentreClient } from "./privacy-centre";

export default async function PrivacyPage() {
  const signedIn = (await cookies()).has("chai_user");
  return (
    <>
      <h1>Your privacy</h1>
      {signedIn ? <PrivacyCentreClient /> : <p className="lede">Please <a href="/">create an account</a> first.</p>}
    </>
  );
}
