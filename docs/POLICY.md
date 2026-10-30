# Writing a company policy

A policy tells RedactGuard what to remove from which kind of document, depending on where the file is going. It's a JSON file. Upload it in the Web Lab ("Company policy" tab) or in the extension's side panel (Settings → Company policy). It's checked on the device; nothing is uploaded anywhere.

The easiest start: in the Web Lab, open **Company policy → Download the example to edit**, change it, and upload it back.

## The shape

```json
{
  "schema": "redactguard.policy/v1",
  "name": "Acme data handling policy",
  "version": "2026.11",
  "owner": "compliance@acme.example",
  "description": "Optional text shown in the Policy tab.",
  "internalDomains": ["acme.example"],
  "dictionaries": { "codenames": ["Project Falcon"], "clients": ["Globex Ltd"] },
  "rules": [ /* see below */ ]
}
```

- `internalDomains`: sites that count as **inside** the company: the host itself or any subdomain (`acme.example` covers `hr.acme.example`). Every other site is **outside**. In the Web Lab you choose inside/outside per scan.
- `dictionaries`: your own word lists (codenames, client names, product names). Matching is whole-word and ignores case.

## A rule

```json
{
  "id": "hr-records",
  "title": "Employee records",
  "clause": "HR-POL 4.1: employee data is shared only with HR systems.",
  "when": { "anyOf": [ { "keywords": ["payslip", "appraisal"] }, { "labels": ["Employee ID"] }, { "findings": ["salary"] } ] },
  "remove": [ { "types": ["name", "pan", "account", "salary"] }, { "pattern": "\\bEMP-\\d{6}\\b", "label": "Employee ID" } ],
  "outside": "remove",
  "inside": "keep"
}
```

- `clause` is your own reference and wording. It's shown next to every item the rule covers ("Required by company policy").
- `when` decides whether the rule applies to a document: `"always"`, or `{ "anyOf": [ … ] }` with any of these signals:

| Signal | Matches when the document… |
|---|---|
| `{ "keywords": ["payslip", …] }` | contains one of the words or phrases |
| `{ "labels": ["Employee ID", …] }` | has a field with that label ("Employee ID: …", or the label alone on a line) |
| `{ "findings": ["salary", …] }` | contains something RedactGuard itself detected, by type (below) |
| `{ "dictionary": "codenames" }` | mentions any term from that dictionary |
| `{ "markings": ["CONFIDENTIAL", …] }` | carries that marking (headers, footers, stamps) |
| `{ "pattern": "…" }` | matches a regular expression (see the limits below) |

- `remove` lists what the rule covers:

| Target | Covers |
|---|---|
| `{ "types": ["name", "pan", …] }` | everything RedactGuard detected of those types |
| `{ "dictionary": "clients", "label": "Client" }` | every occurrence of the dictionary's terms |
| `{ "pattern": "…", "label": "Employee ID" }` | every match of the pattern (`label` names it in the list) |
| `{ "labels": ["Performance Rating", …] }` | the value written next to those labels |
| `{ "detect": "amounts" }` | money amounts (Rs/₹/$/€ amounts, 1,12,430.55) |
| `{ "detect": "secrets" }` | API keys, tokens, private keys, "password: …" values |
| `{ "detect": "internal_links" }` | links to your internal domains, intranet names and private network addresses |

Finding types: `aadhaar`, `pan`, `card`, `ifsc`, `upi`, `phone`, `email`, `vehicle`, `name`, `address`, `medical`, `salary`, `account`, `gps`, `metadata`, `hidden_content`, `old_version`, `other`.

- `outside` / `inside` say what happens for each destination:

| Action | Effect |
|---|---|
| `remove` | the covered items are pre-ticked for removal |
| `block` | the file can't be shared at all: no cleaned copy, no "upload the original anyway" |
| `review` | the covered items are pre-ticked and flagged for a person to check |
| `keep` | allowed: the covered items are left unticked |

When several rules cover the same item, the strictest action wins (block > remove > review > keep).

## Guarantees

- A policy can only make results **stricter**. It never removes something RedactGuard found or lowers a severity, and a trusted site can't relax a policy block.
- Things that are never legitimate to share (hidden text, GPS, file metadata) stay ticked even if a rule says `keep`.
- With no policy turned on, everything behaves exactly as before.
- Turning a policy on or off is written to the tamper-evident audit log with the policy's SHA-256 fingerprint.

## Limits (checked when you upload)

- File size up to 256 KB; up to 100 rules; up to 2,000 terms per dictionary.
- Patterns: up to 200 characters, no back-references, and no nested repetition like `(a+)+`. Each pattern is also timed on long hostile text and refused if it's slow, because some patterns can freeze a scan.
- Every dictionary a rule names must exist, and rule `id`s must be unique.

If a policy is refused, the reason is shown with the path to the problem (for example `rules.2 (hr-records): dictionary "codenames" isn't defined`).
