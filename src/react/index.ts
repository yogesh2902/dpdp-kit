// dpdp-kit/react: hooks (and, from the components PR, screens) over the dpdp-kit HTTP API.
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
