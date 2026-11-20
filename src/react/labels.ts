// The words the ready-made screens use, shared by dpdp-kit/react and dpdp-kit/react-native.
import type { PersonRequest } from "../http.js";
import type { RequestType } from "../records.js";

/** Every piece of text the components show, besides the notice itself (which comes from the server, in the person's language). */
export interface Labels {
  /** For dates: a BCP 47 locale. Default `"en-IN"`. */
  locale: string;
  loading: string;
  failed: string;
  retry: string;
  saved: string;
  notSaved: string;
  language: string;
  acceptSelected: string;
  rejectAll: string;
  continue: string;
  consentsHeading: string;
  consentsIntro: string;
  alwaysOn: string;
  alwaysOnIntro: string;
  dataHeading: string;
  dataIntro: string;
  noData: string;
  sharedWith: string;
  sharedWithNobody: string;
  download: string;
  requestsHeading: string;
  requestsIntro: string;
  requestType: string;
  requestDetails: string;
  sendRequest: string;
  noRequests: string;
  requestTypes: Record<RequestType, string>;
  statuses: Record<PersonRequest["status"], string>;
  opened: string;
  due: string;
  nomineesHeading: string;
  nomineesIntro: string;
  noNominees: string;
  nomineeName: string;
  nomineeContact: string;
  nomineeRelation: string;
  addNominee: string;
  remove: string;
  contactHeading: string;
  howToAsk: string;
  contact: string;
  identifiers: string;
  answerTimes: string;
  days: (n: number) => string;
  grievances: string;
}

export const DEFAULT_LABELS: Labels = {
  locale: "en-IN",
  loading: "Loading…",
  failed: "Couldn't load this.",
  retry: "Try again",
  saved: "Saved.",
  notSaved: "Couldn't save that change. Please try again.",
  language: "Language",
  acceptSelected: "Accept selected",
  rejectAll: "Reject all",
  continue: "Continue",
  consentsHeading: "Your choices",
  consentsIntro: "Turn each use on or off. You can change your mind at any time.",
  alwaysOn: "Needed to provide the service",
  alwaysOnIntro: "We use your data for these without asking, as the law allows:",
  dataHeading: "Your data",
  dataIntro: "What we hold about you, and who we share it with.",
  noData: "We hold no personal data about you.",
  sharedWith: "Shared with",
  sharedWithNobody: "We don't share your data with anyone.",
  download: "Download a copy",
  requestsHeading: "Your requests",
  requestsIntro: "Ask for a copy, a correction or erasure of your data, or raise a complaint.",
  requestType: "What do you need?",
  requestDetails: "Details (optional)",
  sendRequest: "Send request",
  noRequests: "You haven't made any requests.",
  requestTypes: {
    access: "A summary of my data",
    correction: "Correct or update my data",
    erasure: "Erase my data",
    grievance: "A complaint",
    nomination: "A nominee",
  },
  statuses: { open: "Open", resolved: "Answered", rejected: "Declined" },
  opened: "Made",
  due: "Answer due",
  nomineesHeading: "Your nominee",
  nomineesIntro: "Someone who may use these rights for you if you die or can no longer act yourself.",
  noNominees: "You haven't named anyone.",
  nomineeName: "Name",
  nomineeContact: "Email or phone",
  nomineeRelation: "Relation (optional)",
  addNominee: "Add nominee",
  remove: "Remove",
  contactHeading: "How to reach us",
  howToAsk: "To make a request",
  contact: "Data Protection Officer",
  identifiers: "To identify you, we ask for",
  answerTimes: "We answer",
  days: (n) => `within ${n} day${n === 1 ? "" : "s"}`,
  grievances: "Complaints",
};
