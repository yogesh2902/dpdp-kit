// dpdp-kit/react: hooks and ready-made screens over the dpdp-kit HTTP API.
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
} from "./hooks.js";
export { createClient, DpdpClientError } from "../client.js";
export type * from "../client.js";
export {
  ConsentNotice,
  type ConsentNoticeProps,
  ConsentSettings,
  DEFAULT_LABELS,
  HowToReachUs,
  type Labels,
  LanguagePicker,
  type LanguagePickerProps,
  MyData,
  Nominees,
  PrivacyCentre,
  type PrivacyCentreProps,
  type PrivacyCentreSection,
  Requests,
} from "./components.js";
