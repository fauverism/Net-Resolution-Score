import type { Rng } from './rng.ts';

/**
 * Fake identities. Emails use reserved example.* domains and phones use the 555-01xx
 * fictional range, so nothing here can collide with a real person.
 */
export interface Persona {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  accountNumber: string;
  cardLast4: string;
  address: string;
  newAddress: string;
  otherPerson: string;
}

const FIRST = [
  'Maria',
  'James',
  'Aisha',
  'Wei',
  'Carlos',
  'Priya',
  'Daniel',
  'Fatima',
  'Liam',
  'Sofia',
  'Kwame',
  'Hannah',
  'Mateo',
  'Yuki',
  'Olivia',
  'Arjun',
  'Grace',
  'Omar',
  'Elena',
  'Marcus',
  'Chloe',
  'Tariq',
  'Nora',
  'Diego',
  'Amara',
  'Ethan',
  'Leila',
  'Samuel',
  'Ines',
  'Jamal',
  'Rosa',
  'Viktor',
  'Mei',
  'Noah',
  'Zara',
  'Henry',
  'Lucia',
  'Kofi',
  'Ava',
  'Ravi',
] as const;
const LAST = [
  'Garcia',
  'Smith',
  'Okafor',
  'Chen',
  'Rodriguez',
  'Patel',
  'Kim',
  'Haddad',
  'Murphy',
  'Rossi',
  'Mensah',
  'Schmidt',
  'Silva',
  'Tanaka',
  'Johnson',
  'Nair',
  'Williams',
  'Farouk',
  'Petrova',
  'Brown',
  'Dubois',
  'Khan',
  'Lindqvist',
  'Morales',
  'Adeyemi',
  'Clarke',
  'Nasser',
  'Reyes',
  'Costa',
  'Washington',
  'Novak',
  'Ivanova',
  'Lee',
  'Walsh',
  'Hussain',
  'Baker',
  'Moreno',
] as const;
const STREETS = [
  'Maple Ave',
  'Oak St',
  'Cedar Ln',
  'Pine Rd',
  'Elm St',
  'Lakeview Dr',
  'Hillcrest Rd',
  'Willow Way',
  'Park Pl',
  'River Rd',
  'Sunset Blvd',
  'Chestnut St',
  'Birch Ct',
  'Main St',
] as const;
const CITIES = [
  ['Springfield', 'IL', '627'],
  ['Riverton', 'WY', '825'],
  ['Fairview', 'OR', '970'],
  ['Georgetown', 'TX', '786'],
  ['Madison', 'WI', '537'],
  ['Franklin', 'TN', '370'],
  ['Clinton', 'NC', '283'],
  ['Salem', 'MA', '019'],
  ['Ashland', 'KY', '411'],
] as const;
const AREA_CODES = ['212', '312', '415', '503', '617', '702', '804', '919', '267', '480'] as const;
const DOMAINS = ['example.com', 'example.net', 'example.org', 'mail.example.com'] as const;

function digits(rng: Rng, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String(rng.int(0, 9));
  return s;
}

function address(rng: Rng): string {
  const [city, state, zip] = rng.pick(CITIES);
  return `${rng.int(12, 9899)} ${rng.pick(STREETS)}, ${city}, ${state} ${zip}${digits(rng, 2)}`;
}

export function makePersona(rng: Rng): Persona {
  const firstName = rng.pick(FIRST);
  const lastName = rng.pick(LAST);
  const f = firstName.toLowerCase();
  const l = lastName.toLowerCase();
  const local = rng.pick([`${f}.${l}`, `${f}${l}${rng.int(1, 99)}`, `${f[0]}${l}`, `${f}_${l[0]}`]);
  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    email: `${local}@${rng.pick(DOMAINS)}`,
    phone: `(${rng.pick(AREA_CODES)}) 555-01${digits(rng, 2)}`,
    accountNumber: `${rng.int(1, 9)}${digits(rng, 7)}`,
    cardLast4: digits(rng, 4),
    address: address(rng),
    newAddress: address(rng),
    otherPerson: `${rng.pick(FIRST)} ${lastName}`,
  };
}

/** Human agent first names (they count as PII too). */
export const AGENT_NAMES = [
  'Dana',
  'Marcus',
  'Priya',
  'Tom',
  'Keisha',
  'Luis',
  'Jenna',
  'Andre',
  'Beth',
  'Sam',
] as const;
