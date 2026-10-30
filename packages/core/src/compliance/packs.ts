// Built-in starting point (D-039): a general company policy covering the two cases the user asked
// for (employee records, confidential projects) plus identity numbers. Clause wording is generic on
// purpose; companies replace it with their own references. Fake domains and terms only.
import { POLICY_SCHEMA_ID } from "./schema.ts";

export const GENERAL_COMPANY_POLICY = {
  schema: POLICY_SCHEMA_ID,
  name: "General company policy (example)",
  version: "1.0",
  owner: "compliance@example.com",
  description: "Starting point: employee records stay inside HR, confidential projects never leave the company, ID numbers are always removed. Replace the domains, dictionaries and clause text with your own.",
  internalDomains: ["example.com", "intranet.example.com"],
  dictionaries: {
    codenames: ["Project Falcon", "Project Nightjar", "Northwind deal"],
    clients: ["Globex Ltd", "Initech", "Umbrella Corp"],
  },
  rules: [
    {
      id: "hr-records",
      title: "Employee records",
      clause: "Employee personal and pay data is shared only with HR systems.",
      when: {
        anyOf: [
          { keywords: ["payslip", "pay slip", "salary slip", "appraisal", "performance review", "date of joining", "offer letter", "relieving letter", "employee id"] },
          { labels: ["Employee Name", "Employee ID", "Emp ID", "Designation", "CTC", "Gross Salary", "Net Pay"] },
          { findings: ["salary"] },
        ],
      },
      remove: [
        { types: ["name", "address", "phone", "email", "aadhaar", "pan", "account", "ifsc", "upi", "salary"] },
        { pattern: "\\bEMP[-_ ]?\\d{4,8}\\b", label: "Employee ID" },
        { labels: ["Employee ID", "Emp ID", "Performance Rating", "Rating", "Manager Comments", "Reason for Leaving"] },
        { detect: "amounts" },
      ],
      outside: "remove",
      inside: "keep",
    },
    {
      id: "confidential-projects",
      title: "Confidential projects",
      clause: "Confidential project material stays inside the company; inside, names of clients and codenames are need-to-know.",
      when: {
        anyOf: [
          { dictionary: "codenames" },
          { markings: ["STRICTLY CONFIDENTIAL", "CONFIDENTIAL", "INTERNAL ONLY", "NOT FOR DISTRIBUTION", "PRIVILEGED"] },
        ],
      },
      remove: [
        { dictionary: "codenames", label: "Codename" },
        { dictionary: "clients", label: "Client" },
        { types: ["name", "email", "phone"] },
        { detect: "amounts" },
        { detect: "internal_links" },
      ],
      outside: "block",
      inside: "remove",
    },
    {
      id: "secrets",
      title: "Credentials",
      clause: "Passwords, API keys and private keys are never shared in documents.",
      when: "always",
      remove: [{ detect: "secrets" }],
      outside: "remove",
      inside: "remove",
    },
    {
      id: "id-numbers",
      title: "Identity and card numbers",
      clause: "Full Aadhaar and card numbers never leave a document.",
      when: "always",
      remove: [{ types: ["aadhaar", "card"] }],
      outside: "remove",
      inside: "remove",
    },
  ],
} as const;
