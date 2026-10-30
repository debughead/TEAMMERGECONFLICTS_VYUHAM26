// Lightweight entry for UI and messaging code (extension side panel, background): policy validation and
// types without pulling MuPDF/WASM into those bundles.
export {
  ComplianceReport, CompliancePolicy, Destination, MAX_POLICY_BYTES, POLICY_SCHEMA_ID,
  type ComplianceItem, type LoadedPolicy, type PolicyAction, type PolicyRule,
} from "./schema.ts";
export { parsePolicy, destinationFor, type PolicyLoad } from "./load.ts";
export { GENERAL_COMPANY_POLICY } from "./packs.ts";
