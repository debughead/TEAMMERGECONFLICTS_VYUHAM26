# Edge test cases: phase 0

Edge cases that real documents, OCR output or hostile pages can produce. Each test checks what RedactGuard **should** do, so a failing test marks a gap in the code, not a broken test. Passing tests lock in behaviour that already works.

Run against `main` at `cb1e1a0`. The existing QR-code test in `imageForensics.test.ts` is out of scope and not counted here.

**98 test cases: 58 failing, 40 passing.**

Run them with:

```bash
cd packages/core && npx vitest run test/edge.test.ts test/edge2.test.ts
```

## `packages/core/test/edge.test.ts` (39 failing of 73)


### Aadhaar formatting seen in real documents

| # | Test case | Result |
|---|---|---|
| 1 | mixed separators (space then hyphen) | ❌ Fail |
| 2 | double spaces from OCR / justified text | ❌ Fail |
| 3 | number wrapped onto the next line of a PDF | ❌ Fail |
| 4 | dot-separated groups | ❌ Fail |
| 5 | 16-digit Aadhaar Virtual ID next to the VID keyword | ❌ Fail |
| 6 | 12 digits glued to a word (OCR drops the space) | ✅ Pass |

### other IDs in less common but valid shapes

| # | Test case | Result |
|---|---|---|
| 1 | lower-case PAN (typed into a form) | ❌ Fail |
| 2 | PAN with OCR spaces | ❌ Fail |
| 3 | mobile number grouped 4-3-3 | ❌ Fail |
| 4 | mobile number with +91 in brackets | ✅ Pass |
| 5 | card number with dots | ❌ Fail |
| 6 | 'Acc No.' abbreviation for a bank account | ❌ Fail |
| 7 | Bharat-series vehicle number | ❌ Fail |
| 8 | UPI built on a phone number is reported once, as UPI | ✅ Pass |

### validators: boundaries

| # | Test case | Result |
|---|---|---|
| 1 | empty / non-digit input never passes a checksum | ✅ Pass |
| 2 | all-zeros passes Luhn but is not a card | ✅ Pass |
| 3 | 20-digit numbers are not cards | ✅ Pass |

### display masks never reveal the whole value

| # | Test case | Result |
|---|---|---|
| 1 | a one-letter email user name is not shown in full | ❌ Fail |
| 2 | name masks have a fixed length per word (no length leak) | ✅ Pass |

### local NER: real-world casing and formats

| # | Test case | Result |
|---|---|---|
| 1 | lower-case name after a Name label | ✅ Pass |
| 2 | salary with no currency symbol or commas | ❌ Fail |
| 3 | salary written in lakhs | ❌ Fail |
| 4 | PIN code written with a hyphen | ❌ Fail |

### AI minimiser: nothing identifying leaves in clear

| # | Test case | Result |
|---|---|---|
| 1 | a lower-case PAN missed by the detector is still masked | ❌ Fail |
| 2 | a lower-case labelled name is masked | ✅ Pass |
| 3 | an email in a context line is masked | ✅ Pass |
| 4 | a single huge line still produces chunks under the request limit | ❌ Fail |

### policy: page text is attacker-controlled

| # | Test case | Result |
|---|---|---|
| 1 | a lookalike domain containing 'aadhaar' does not make Aadhaar 'expected' | ❌ Fail |
| 2 | a job portal 'Statement of Purpose' field doesn't make bank account numbers expected | ❌ Fail |
| 3 | 'Japan visa application' is not treated as a PAN page | ✅ Pass |
| 4 | a hidden leak on a trusted site is still at least a warning | ✅ Pass |
| 5 | an AI reply cannot mark card numbers as needed | ✅ Pass |

### score

| # | Test case | Result |
|---|---|---|
| 1 | is capped at 100 and is 0 for nothing | ✅ Pass |

### audit chain tamper evidence

| # | Test case | Result |
|---|---|---|
| 1 | deleting the newest row is detected | ❌ Fail |
| 2 | wiping the whole log is detected | ❌ Fail |
| 3 | deleting a middle row is detected | ✅ Pass |
| 4 | concurrent appends never fork the chain | ✅ Pass |
| 5 | detail longer than the limit is cut without breaking the hash | ✅ Pass |
| 6 | canonical JSON is key-order independent | ✅ Pass |

### file sniffing

| # | Test case | Result |
|---|---|---|
| 1 | a PDF with junk before %PDF- (allowed by readers) is still scanned as PDF | ❌ Fail |
| 2 | a PDF with a UTF-8 BOM is still scanned as PDF | ❌ Fail |
| 3 | an empty file is rejected cleanly | ✅ Pass |
| 4 | a truncated JPEG header is rejected as malformed, not crashed on | ✅ Pass |
| 5 | a PNG claiming 2^32-1 × 2^32-1 pixels is rejected | ✅ Pass |
| 6 | a zip under 22 bytes is malformed, not an out-of-range read | ✅ Pass |
| 7 | a file one byte over the extension limit is too_large | ✅ Pass |

### geometry

| # | Test case | Result |
|---|---|---|
| 1 | zero-area rects have zero coverage | ✅ Pass |
| 2 | pure black in gray / RGB / CMYK is dark | ✅ Pass |

### repo integrity

| # | Test case | Result |
|---|---|---|
| 1 | every samples/*.expected.json has its sample file | ✅ Pass |
| 2 | sample files referenced by tests exist | ✅ Pass |

### OCR PAN repair must not invent PANs from ordinary words

| # | Test case | Result |
|---|---|---|
| 1 | 'capability' in OCR text is not a PAN | ❌ Fail |
| 2 | 'durability' in OCR text is not a PAN | ❌ Fail |
| 3 | 'affability' in OCR text is not a PAN | ❌ Fail |
| 4 | 'apparition' in OCR text is not a PAN | ❌ Fail |
| 5 | still repairs a real misread PAN (regression) | ✅ Pass |
| 6 | a lower-case PAN is found in typed text, not only in OCR text | ❌ Fail |

### dates of birth

| # | Test case | Result |
|---|---|---|
| 1 | Year of Birth only (older Aadhaar cards) | ❌ Fail |
| 2 | month written as a word | ❌ Fail |
| 3 | ISO date | ❌ Fail |
| 4 | two-digit year | ❌ Fail |
| 5 | on an Aadhaar card, the issue / download date is not a date of birth | ❌ Fail |
| 6 | a 'DOB' label with no date doesn't pick up an unrelated date two lines down | ✅ Pass |

### names printed under a 'Name' label on cards

| # | Test case | Result |
|---|---|---|
| 1 | a form heading under 'Name' is not a person's name | ❌ Fail |
| 2 | still finds the real name (regression) | ✅ Pass |

### 'AC' account label

| # | Test case | Result |
|---|---|---|
| 1 | a phone number on the line after a line ending in 'AC' stays a phone number | ❌ Fail |
| 2 | 'LOAN AC 7781200045' is an account (regression) | ✅ Pass |

### JPEG metadata stripping

| # | Test case | Result |
|---|---|---|
| 1 | drops a JFXX thumbnail (a copy of the unredacted photo) | ❌ Fail |
| 2 | drops the RGB thumbnail inside a JFIF APP0 header | ❌ Fail |
| 3 | drops EXIF, XMP and comments (regression) | ✅ Pass |
| 4 | drops data appended after the end-of-image marker | ✅ Pass |
| 5 | a segment length running past the end returns null instead of reading out of range | ✅ Pass |

### OCR engine fallback

| # | Test case | Result |
|---|---|---|
| 1 | loads the fallback engine once, not once per image | ❌ Fail |
| 2 | reports the binarize setting of the engine that actually read the image | ❌ Fail |

## `packages/core/test/edge2.test.ts` (19 failing of 25)


### DOCX: text outside the main body is still scanned

| # | Test case | Result |
|---|---|---|
| 1 | footer (letterheads often carry phone / PAN) | ❌ Fail |
| 2 | header | ❌ Fail |
| 3 | footnotes | ❌ Fail |
| 4 | text after a text box in the same paragraph | ❌ Fail |

### DOCX: text that is hidden by formatting is reported as hidden

| # | Test case | Result |
|---|---|---|
| 1 | white text | ❌ Fail |
| 2 | 1 pt text | ❌ Fail |
| 3 | hidden text with an explicit w:val="true" (regression) | ✅ Pass |

### XLSX: common writer output is read correctly

| # | Test case | Result |
|---|---|---|
| 1 | a text cell right after an empty styled cell (<c .../>) | ❌ Fail |
| 2 | a hidden row after an empty self-closing row is still reported as hidden | ❌ Fail |
| 3 | sheets written with a namespace prefix (<x:row>, <x:c>) | ❌ Fail |
| 4 | a zero-width column is treated as hidden | ❌ Fail |

### Office clean removes every place personal data hides

| # | Test case | Result |
|---|---|---|
| 1 | custom document properties are reported as metadata | ❌ Fail |
| 2 | custom document properties are removed by clean | ❌ Fail |
| 3 | the saved preview thumbnail (a picture of page 1) is removed | ❌ Fail |
| 4 | the author in core.xml is removed (regression) | ✅ Pass |

### AI prompts: untrusted text can't break out of its tags

| # | Test case | Result |
|---|---|---|
| 1 | a document line containing </document> can't close the document block early | ❌ Fail |
| 2 | a page label with line breaks can't fake the 'Kinds of data found' line | ❌ Fail |

### AI findings: replies are checked before they become findings

| # | Test case | Result |
|---|---|---|
| 1 | a one-letter 'finding' is ignored (would redact a random letter) | ❌ Fail |
| 2 | a finding that is only a common word is ignored | ❌ Fail |
| 3 | a real medical detail is accepted (regression) | ✅ Pass |
| 4 | a malformed reply adds nothing | ✅ Pass |

### identity-kit combinations

| # | Test case | Result |
|---|---|---|
| 1 | name + PAN + date of birth (enough for PAN-based loan fraud) | ❌ Fail |
| 2 | name + Aadhaar + email | ❌ Fail |
| 3 | name + Aadhaar + address (regression) | ✅ Pass |
| 4 | name + phone alone is not a kit (regression) | ✅ Pass |
