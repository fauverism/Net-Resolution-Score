import type { PiiMention, PiiType } from '@nrs/core';
import type { Persona } from './pii.ts';
import type { Rng } from './rng.ts';

/** Per-journey scenario values, shared by an interaction and its return contacts. */
export interface JourneyVars {
  amount: string;
  newAmount: string;
  chargeDate: string;
  plan: string;
  newPlan: string;
  device: string;
  errorCode: string;
  speed: string;
  ref: string;
  /** "on Monday", "a few days ago"… Only set on return contacts. */
  prevWhen: string;
}

/** Template context. Every PII accessor records what it inserted, for redaction evals. */
export class Ctx {
  readonly pii: PiiMention[] = [];

  constructor(
    readonly rng: Rng,
    private readonly persona: Persona,
    readonly v: JourneyVars,
    private readonly agentName: string,
  ) {}

  private rec(type: PiiType, value: string): string {
    this.pii.push({ type, value });
    return value;
  }

  name = () => this.rec('name', this.persona.fullName);
  first = () => this.rec('name', this.persona.firstName);
  other = () => this.rec('name', this.persona.otherPerson);
  email = () => this.rec('email', this.persona.email);
  phone = () => this.rec('phone', this.persona.phone);
  card = () => this.rec('card_last4', this.persona.cardLast4);
  address = () => this.rec('address', this.persona.address);
  newAddress = () => this.rec('address', this.persona.newAddress);
  agent = () => this.rec('agent_name', this.agentName);

  /** Account number in one of several real-world formats. */
  account = () => {
    const a = this.persona.accountNumber;
    return this.rec(
      'account_number',
      this.rng.pick([a, `ACCT-${a}`, `${a.slice(0, 4)}-${a.slice(4)}`, `#${a}`]),
    );
  };

  /** Pick a template and render it. */
  say = (lines: readonly Line[]): string => this.rng.pick(lines)(this);
}

export type Line = (c: Ctx) => string;
