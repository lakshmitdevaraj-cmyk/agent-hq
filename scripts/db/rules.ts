// The live rules the import reuses, straight from the app's own code (nothing is rewritten here).
export { emailKey, websiteKey, placeIdKey, isAutoReply } from "../../netlify/functions/lib/outreach";
export { isSystemReply, isBounceReport, isTestReply, ownReplyEmailIds } from "../../netlify/functions/lib/replies";
export { nextFollowUp, gapsOrDefault } from "../../netlify/functions/lib/followups";
export { STATE_TZ, stateFromAddress } from "../../netlify/functions/lib/replydraft";
