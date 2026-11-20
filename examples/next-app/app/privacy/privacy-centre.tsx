"use client";
import { DpdpProvider, PrivacyCentre } from "dpdp-kit/react";

export function PrivacyCentreClient() {
  return (
    <DpdpProvider options={{ base: "/privacy" }}>
      <PrivacyCentre />
    </DpdpProvider>
  );
}
