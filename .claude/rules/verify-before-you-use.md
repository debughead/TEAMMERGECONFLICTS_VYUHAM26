# Verify before you use (applies everywhere)

Hallucinated APIs are the biggest risk in this project, because several libraries (MuPDF.js, Tesseract.js, PDF.js) have APIs that changed across versions.

Before writing a call to a library function:

1. Check `docs/VERIFIED_APIS.md`. If the call is listed for the installed version, use it as recorded.
2. Otherwise open the installed package's type definitions (`node_modules/<pkg>/**/*.d.ts`) or README and confirm the exact name, parameters and return type. Note the package version from `package.json`.
3. Write a tiny check (a unit test or a scratch script) that calls it on a sample file and confirm it behaves as expected.
4. Add a row to `docs/VERIFIED_APIS.md`: package, version, call, what it returns, where you confirmed it, date.

If step 2 or 3 fails, write "UNVERIFIED: <call>" in your update and stop to ask. Never paper over it with a guessed signature, a `// @ts-ignore`, or an `any` cast.

Also:
- Don't quote numbers, limits or behaviours of Chrome APIs from memory; cite the Chrome developer docs page you checked.
- When you summarise what you did, every claim of "works" must point to a command you ran in this session.
