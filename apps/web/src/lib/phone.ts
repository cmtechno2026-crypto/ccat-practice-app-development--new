// Browser phone validation with REDUCED metadata. Instead of libphonenumber-js's full ~140KB
// metadata, we bundle `phone-metadata.json` — generated with `libphonenumber-metadata-generator
// --countries CA,US,GB,IN,AU,AE,PK,NG,SG,ZA --extended`, i.e. ONLY the countries the onboarding
// selector offers, at full ("extended") validation precision. The gateway keeps the full
// `libphonenumber-js` library for authoritative re-validation of any input.
//
// Regenerate after changing the country list (keep it in sync with COUNTRIES in RegisterScreen):
//   cd apps/web && npx libphonenumber-metadata-generator src/lib/phone-metadata.json \
//     --countries CA,US,GB,IN,AU,AE,PK,NG,SG,ZA --extended
import { parsePhoneNumberFromString } from 'libphonenumber-js/core';
import type { CountryCode } from 'libphonenumber-js/core';
import metadata from './phone-metadata.json';

export type { CountryCode };

// Parse a national number for the chosen country. Returns a valid PhoneNumber or undefined.
export function parsePhone(input: string, country: CountryCode) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return parsePhoneNumberFromString(input, country, metadata as any);
}
