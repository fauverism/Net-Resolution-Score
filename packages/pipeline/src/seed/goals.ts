import type { Line } from './ctx.ts';

export const BUSINESS_LINES = ['billing', 'tech_support', 'account_changes'] as const;
export type BusinessLine = (typeof BUSINESS_LINES)[number];

export const TEAM_NAME: Record<BusinessLine, string> = {
  billing: 'billing',
  tech_support: 'technical support',
  account_changes: 'accounts',
};

/** A customer goal and the template lines used to tell its story. */
export interface Goal {
  id: string;
  businessLine: BusinessLine;
  summary: string;
  /** Customer's first message. */
  open: readonly Line[];
  /** Customer's first message when coming back about the same goal. */
  returnOpen: readonly Line[];
  /** Agent question → customer answer. */
  probes: readonly (readonly [Line, Line])[];
  /** Agent suggestion → customer says it didn't help. Each one adds effort. */
  troubleshoot: readonly (readonly [Line, Line])[];
  /** Agent actually fixes it. */
  fix: readonly Line[];
  /** Customer confirms the fix worked. confirm[i] answers fix[i]. */
  confirm: readonly Line[];
  /** Agent claims it's fixed, but it isn't (false resolution). */
  falseFix: readonly Line[];
  /** Agent can't resolve it in this contact. */
  cantFix: readonly Line[];
}

export const GOALS: readonly Goal[] = [
  // ───────────── billing ─────────────
  {
    id: 'duplicate_charge',
    businessLine: 'billing',
    summary: 'Dispute a duplicate charge on the bill',
    open: [
      (c) =>
        `Hi, I was charged twice for my bill this month. I see two payments of ${c.v.amount} on my card.`,
      (c) =>
        `There's a double charge on my account, ${c.v.amount} came out twice on ${c.v.chargeDate}.`,
      (c) =>
        `Why did you take ${c.v.amount} from my card two times?? I need one of those refunded.`,
      (c) => `Hello. My name is ${c.name()} and I think I got billed twice for the same month.`,
    ],
    returnOpen: [
      (c) =>
        `I contacted you ${c.v.prevWhen} about being charged twice (${c.v.amount}). I was told it was refunded but nothing has come back to my card.`,
      (c) =>
        `Still waiting on the refund for the double charge of ${c.v.amount}. This is the second time I'm reaching out about this.`,
      (c) =>
        `I chatted with you ${c.v.prevWhen} about a duplicate payment and it's still showing twice on my statement.`,
    ],
    probes: [
      [
        () => `I'm sorry about that. Which card was charged? The last four digits are fine.`,
        (c) => `It's the card ending in ${c.card()}.`,
      ],
      [
        () => `Do both charges show as posted, or is one still pending?`,
        (c) => `Both are posted. Both on ${c.v.chargeDate}.`,
      ],
      [
        () => `Can you tell me the exact amount of each charge?`,
        (c) => `${c.v.amount} and ${c.v.amount}. Exactly the same.`,
      ],
    ],
    troubleshoot: [
      [
        () =>
          `Sometimes the second charge is a temporary authorization that drops off in 3 to 5 business days. Has it been longer than that?`,
        () => `Yes, it's been over a week. It's definitely a real charge.`,
      ],
      [
        () => `Could you check whether you have two accounts set up for autopay?`,
        () => `I only have one account. I already checked.`,
      ],
      [
        () => `Did you also make a manual payment on the same day?`,
        () => `No, I didn't make any manual payment. Autopay just ran twice.`,
      ],
      [
        () =>
          `Can you check your bank app to see if the second one is a hold rather than a charge?`,
        () => `It's a charge. The money is gone from my account.`,
      ],
    ],
    fix: [
      (c) =>
        `I can see the duplicate payment of ${c.v.amount}. I've issued a refund for it. You'll see it on the card in 3 to 5 business days, and your refund reference is ${c.v.ref}.`,
      (c) =>
        `You're right, autopay ran twice. I've reversed the second payment and emailed you a confirmation with reference ${c.v.ref}.`,
    ],
    confirm: [
      () => `Okay, I just got the confirmation email with the refund reference. Thank you.`,
      () => `Great, I can see the reversal pending in my bank app already. Thanks.`,
    ],
    falseFix: [
      () =>
        `I've corrected the duplicate charge on your account. Everything is resolved now and your balance is up to date!`,
      (c) =>
        `All set! The extra ${c.v.amount} payment has been taken care of and the issue is fixed.`,
    ],
    cantFix: [
      () =>
        `I'm not able to issue refunds over this amount myself. I've sent a request to our billing team and they'll review it within 5 to 7 business days.`,
      () =>
        `I'm only seeing one charge on our side, so the second may still be processing. If it's still there in a few days, please contact us again.`,
    ],
  },
  {
    id: 'bill_increase',
    businessLine: 'billing',
    summary: 'Understand why the bill went up',
    open: [
      (c) =>
        `My bill went from ${c.v.amount} to ${c.v.newAmount} and nobody told me anything. What happened?`,
      (c) => `Why is my bill ${c.v.newAmount} this month? It's usually ${c.v.amount}.`,
      () =>
        `Hi, I'd like to understand some charges on my latest bill. It's a lot higher than normal.`,
    ],
    returnOpen: [
      (c) =>
        `I asked about my bill going up to ${c.v.newAmount} ${c.v.prevWhen}. I was told it would be adjusted but the new bill is still wrong.`,
      () => `Contacting you again about the price increase on my bill. It still hasn't been fixed.`,
    ],
    probes: [
      [
        () =>
          `I can help with that. Have you made any changes to your plan or added anything recently?`,
        () => `No, I haven't changed anything at all.`,
      ],
      [
        () => `Which billing period are you looking at?`,
        (c) => `The one that was charged on ${c.v.chargeDate}.`,
      ],
    ],
    troubleshoot: [
      [
        () =>
          `It looks like your promotional discount ended last cycle. Did you receive a notice about that?`,
        () => `No, I never got any notice. I'd have remembered.`,
      ],
      [
        () => `There's an equipment fee on the bill. Do you have a second device on the account?`,
        () => `No, I only have the one device. I returned the old one months ago.`,
      ],
      [
        () =>
          `Could you check whether paperless billing is still turned on? There's a paper bill fee.`,
        () => `I'm on paperless, I've been on paperless for years.`,
      ],
    ],
    fix: [
      (c) =>
        `I found it. A promotional rate expired and you weren't notified, which isn't right. I've applied a 12-month loyalty credit, so your bill goes back to ${c.v.amount}. Reference ${c.v.ref}.`,
      () =>
        `There was an equipment fee for a device that was already returned. I've removed it and credited the difference to this bill.`,
    ],
    confirm: [
      () => `Okay, I can see the credit on my account page now. Thanks for sorting it out.`,
      () => `That makes sense. I see the adjusted balance. Thank you.`,
    ],
    falseFix: [
      () => `I've reviewed your bill and adjusted it. Your next bill will be back to normal!`,
      () => `Done! The extra charges have been resolved on your account.`,
    ],
    cantFix: [
      () =>
        `The increase is from a rate change that applies to all customers on your plan, so I'm not able to remove it. I can share the notice we sent out if that helps.`,
      () =>
        `I'd need a supervisor to approve a credit this size. I've escalated the request and you should hear back in 2 to 3 business days.`,
    ],
  },
  {
    id: 'late_fee_waiver',
    businessLine: 'billing',
    summary: 'Get a late fee waived',
    open: [
      () => `I got hit with a late fee but I paid on time. Can you take it off?`,
      () =>
        `Hi, can you waive the late fee on my account? My payment was only one day late because of a bank holiday.`,
      (c) =>
        `There's a $15 late fee on my bill and I paid ${c.v.amount} on ${c.v.chargeDate}. That's before the due date.`,
    ],
    returnOpen: [
      (c) => `I was told ${c.v.prevWhen} the late fee would be removed but it's still on my bill.`,
      () => `The late fee is still there. I already called about this once.`,
    ],
    probes: [
      [
        () => `When did you make the payment, and how did you pay?`,
        (c) => `Online, through the website, on ${c.v.chargeDate}.`,
      ],
      [
        () => `Do you have a confirmation number for the payment?`,
        () => `I have the confirmation email, yes. It went through right away.`,
      ],
    ],
    troubleshoot: [
      [
        () => `Payments made after 5pm post the next business day. Could that be what happened?`,
        () => `I paid in the morning. It wasn't after 5.`,
      ],
      [
        () => `Can you check that the payment went to this account and not an old one?`,
        () => `It's the only account I have.`,
      ],
    ],
    fix: [
      () =>
        `I see your payment was received on time but posted late on our end. I've removed the $15 late fee, and you'll see the credit on your next statement.`,
      () =>
        `You have a great payment history, so I've waived the late fee as a one-time courtesy. It's been removed.`,
    ],
    confirm: [
      () => `Perfect, the balance on my account page dropped by $15. Thanks!`,
      () => `Great, thank you, I can see it's gone.`,
    ],
    falseFix: [
      () => `I've taken care of the late fee for you. You're all set!`,
      () => `The late fee has been waived. Is there anything else I can help with?`,
    ],
    cantFix: [
      () =>
        `I'm sorry, but our records show the payment arrived after the due date, so I can't waive the fee this time.`,
      () =>
        `Fee waivers have to be approved by the billing team. I've submitted the request, but I can't promise the outcome.`,
    ],
  },
  {
    id: 'payment_failed',
    businessLine: 'billing',
    summary: 'Fix a failing payment',
    open: [
      () => `I keep trying to pay my bill online and it says payment declined. My card is fine.`,
      (c) => `My autopay failed and now I'm getting texts at ${c.phone()} saying I'm past due.`,
      () => `Hello, I can't make a payment. The website just gives an error every time.`,
    ],
    returnOpen: [
      (c) => `I reached out ${c.v.prevWhen} because my payment kept failing. It's still failing.`,
      () => `My payment is still being declined. I was told this was fixed.`,
    ],
    probes: [
      [
        () => `What message do you see when the payment fails?`,
        (c) => `It says "Payment could not be processed" with code ${c.v.errorCode}.`,
      ],
      [() => `Which card are you using?`, (c) => `A Visa ending in ${c.card()}.`],
    ],
    troubleshoot: [
      [
        () => `Can you try clearing your browser cache and trying again?`,
        () => `Tried it, same error.`,
      ],
      [
        () => `Could you try a different card or a bank account?`,
        () => `I tried my other card too. Same thing.`,
      ],
      [
        () => `Is the billing ZIP code on the card the same as the one on your account?`,
        () => `Yes, it's the same, I just double checked.`,
      ],
    ],
    fix: [
      () =>
        `I see the problem. Your account had an old card blocked after it expired, and it was blocking new cards too. I've cleared that, so please try the payment again now.`,
      () =>
        `I've processed the payment for you over chat with the card you gave me. It went through, and your account is current.`,
    ],
    confirm: [
      () => `It went through! I got the receipt. Thank you.`,
      () => `Yes, it says paid now. Finally.`,
    ],
    falseFix: [
      () =>
        `I've reset your payment settings and the issue is resolved. You should be able to pay now!`,
      () => `Your payment method has been fixed. Everything should work going forward.`,
    ],
    cantFix: [
      () =>
        `It looks like the decline is coming from your bank, not from us. You'll need to contact your card issuer.`,
      () =>
        `Our payment system is having intermittent issues today. Please try again tomorrow, and no late fee will be applied.`,
    ],
  },

  // ───────────── tech_support ─────────────
  {
    id: 'outage',
    businessLine: 'tech_support',
    summary: 'Internet service is down',
    open: [
      () => `My internet has been down since this morning. Is there an outage?`,
      () => `Nothing is working. No internet at all, the router light is red.`,
      (c) =>
        `Hi, my service at ${c.address()} is completely out. I work from home and I need this fixed.`,
    ],
    returnOpen: [
      (c) =>
        `My internet went out again. I contacted you ${c.v.prevWhen} and was told it was fixed.`,
      () => `Same problem as last time. The internet keeps dropping and I already reported this.`,
    ],
    probes: [
      [
        () => `I'm sorry to hear that. What color are the lights on your router right now?`,
        () => `The power light is green but the internet light is red.`,
      ],
      [
        () => `How many devices are affected? Is it just one, or everything?`,
        () => `Everything. Phones, laptop, TV.`,
      ],
      [(c) => `Is the service address still ${c.address()}?`, () => `Yes, that's right.`],
    ],
    troubleshoot: [
      [
        () => `Please unplug the router for 30 seconds, then plug it back in and wait two minutes.`,
        () => `Okay, I did that. The light is still red.`,
      ],
      [
        () => `Can you check that the cable from the wall is firmly connected to the router?`,
        () => `It's plugged in tight, I checked both ends.`,
      ],
      [
        () => `Let's try a factory reset. Hold the reset button on the back for 10 seconds.`,
        () => `Did that. It came back up but still no internet.`,
      ],
      [
        () =>
          `I'm sending a refresh signal to your modem now. Can you let me know if the light changes?`,
        () => `Nope, still red.`,
      ],
    ],
    fix: [
      () =>
        `I found a provisioning error on your line and I've corrected it. Your router should reconnect in about a minute.`,
      () =>
        `There was an outage in your area that our crew just repaired. I've refreshed your connection from our side.`,
    ],
    confirm: [
      () => `Okay, the light just turned green and my laptop is back online. Thanks!`,
      () => `It's working now, I can load pages again.`,
    ],
    falseFix: [
      () =>
        `I've refreshed your connection and the issue has been resolved! Your internet should be working now.`,
      () => `Great news, I've fixed the problem on our end. You're all set!`,
    ],
    cantFix: [
      (c) =>
        `This looks like a line issue that needs a technician. The earliest appointment is in three days, and I've booked it under reference ${c.v.ref}.`,
      () =>
        `There's a known outage in your area. Crews are working on it but we don't have an estimated time yet.`,
    ],
  },
  {
    id: 'slow_speed',
    businessLine: 'tech_support',
    summary: 'Internet is much slower than the plan',
    open: [
      (c) => `I'm paying for ${c.v.plan} but I'm getting like ${c.v.speed} Mbps. What's going on?`,
      () => `My internet has been super slow for a week. Video calls keep freezing.`,
      () => `Hi, my speeds are terrible in the evenings. Can someone look into it?`,
    ],
    returnOpen: [
      (c) => `My speeds are still slow. I talked to someone ${c.v.prevWhen} and nothing changed.`,
      (c) => `Back again about slow internet. Still only getting ${c.v.speed} Mbps.`,
    ],
    probes: [
      [
        () => `Are you testing over Wi-Fi or with a cable plugged into the router?`,
        () => `Wi-Fi mostly, but I tried wired too and it's slow both ways.`,
      ],
      [
        () => `What time of day do you notice it most?`,
        () => `Evenings, like 7 to 11pm, but sometimes during the day too.`,
      ],
    ],
    troubleshoot: [
      [
        () => `Please restart the router and run a speed test again.`,
        (c) => `Restarted it. Still ${c.v.speed} Mbps.`,
      ],
      [
        () => `Could you move the router somewhere more central, away from the microwave?`,
        () => `It's already in the middle of the apartment. Not near the microwave.`,
      ],
      [
        () => `Can you disconnect the other devices and test with just one?`,
        () => `Only my laptop is connected now and it's still slow.`,
      ],
    ],
    fix: [
      (c) =>
        `Your modem was provisioned for an older plan, so it was capped below ${c.v.plan}. I've pushed the correct configuration. Please restart and test again.`,
      () =>
        `Your router firmware was very out of date. I've pushed an update, and once it reboots you should see full speeds.`,
    ],
    confirm: [
      () => `Wow, the speed test shows over 400 now. That fixed it.`,
      () => `Much better. Thanks for figuring it out.`,
    ],
    falseFix: [
      () =>
        `I've optimized your connection from our end. Your speeds should be back to normal now!`,
      () => `I ran a line refresh and everything looks great on our side. Your issue is resolved.`,
    ],
    cantFix: [
      () =>
        `Our network in your area is congested in the evenings. An upgrade is scheduled but I don't have a date.`,
      () =>
        `I'd like a technician to test the line. I've opened a ticket and someone will call you to schedule.`,
    ],
  },
  {
    id: 'password_reset',
    businessLine: 'tech_support',
    summary: 'Reset a password / regain access',
    open: [
      () => `I forgot my password and the reset email never shows up.`,
      (c) => `I'm locked out of my account. My login email is ${c.email()}.`,
      () => `Hi, I need to reset my password but it says my security answers are wrong.`,
    ],
    returnOpen: [
      (c) =>
        `I still can't log in. I asked for a password reset ${c.v.prevWhen} and it never worked.`,
      () => `Locked out again. The reset you did last time didn't stick.`,
    ],
    probes: [
      [() => `Which email address is the account under?`, (c) => `${c.email()}.`],
      [
        () => `Have you checked your spam or junk folder for the reset email?`,
        () => `Yes, it's not in spam either.`,
      ],
      [
        () => `To verify it's you, can you confirm the phone number on the account?`,
        (c) => `${c.phone()}.`,
      ],
    ],
    troubleshoot: [
      [
        () => `I've sent another reset link. Can you check your inbox in a minute?`,
        () => `Still nothing. I've refreshed a bunch of times.`,
      ],
      [
        () => `Please try requesting the reset from the mobile app instead of the website.`,
        () => `The app gives me the same error.`,
      ],
    ],
    fix: [
      (c) =>
        `Your account was locked after too many attempts. I've unlocked it and sent a one-time code to ${c.phone()}. Use it to set a new password.`,
      () =>
        `The reset emails were bouncing because of a typo in your email on file. I've corrected it and sent a new link.`,
    ],
    confirm: [
      () => `Got the code, I'm in. New password set. Thanks!`,
      () => `The link came through this time and I'm logged in.`,
    ],
    falseFix: [
      () => `I've reset your password and you should receive an email shortly. You're all set!`,
      () => `Your account has been unlocked and the issue is fixed.`,
    ],
    cantFix: [
      () =>
        `I can't verify your identity over chat. You'll need to visit a store with a photo ID to reset access.`,
      () => `Our login system is down for maintenance right now. Please try again in a few hours.`,
    ],
  },
  {
    id: 'app_login_error',
    businessLine: 'tech_support',
    summary: 'Mobile app shows an error on login',
    open: [
      (c) => `The app keeps crashing when I log in. It shows error ${c.v.errorCode}.`,
      (c) => `Your app won't let me in on my ${c.v.device}. Just spins forever.`,
      () => `Hey, the mobile app logs me out every time I open it. Super annoying.`,
    ],
    returnOpen: [
      (c) => `The app is still giving me error ${c.v.errorCode}. I reported this ${c.v.prevWhen}.`,
      () => `App still broken. Same issue as when I contacted you before.`,
    ],
    probes: [
      [
        () => `What device and app version are you using?`,
        (c) => `${c.v.device}, and I think the latest version. I updated last week.`,
      ],
      [
        () => `Does logging in on the website work?`,
        () => `Yes, the website works fine. Just the app.`,
      ],
    ],
    troubleshoot: [
      [
        () => `Please delete the app, reinstall it, and log in again.`,
        () => `Reinstalled it. Same error.`,
      ],
      [
        () => `Can you try turning off Wi-Fi and logging in over mobile data?`,
        () => `Tried mobile data, no difference.`,
      ],
      [
        () => `Please clear the app's cache in your phone settings.`,
        () => `Cleared it. Still crashing.`,
      ],
    ],
    fix: [
      () =>
        `Your account had a stale session token that crashes older app builds. I've cleared it on our end. Please try logging in once more.`,
      () =>
        `There's a known bug in this version. I've moved your account onto the fix early, so please force-close the app and reopen it.`,
    ],
    confirm: [
      () => `That worked, I'm in the app now.`,
      () => `Okay it opened normally this time. Thank you!`,
    ],
    falseFix: [
      () => `I've reset your app session and the issue is now resolved. You should be good to go!`,
      () => `This has been fixed on our side. Let us know if you need anything else!`,
    ],
    cantFix: [
      () =>
        `Our engineers are aware of this error and are working on an update. For now, please use the website.`,
      () =>
        `I've reported this to the app team with your details. I don't have a timeline for a fix yet.`,
    ],
  },
  {
    id: 'router_setup',
    businessLine: 'tech_support',
    summary: 'Set up a new router',
    open: [
      () => `I just got the new router in the mail and I can't get it set up.`,
      () => `Hi, I'm trying to install my replacement router and it won't connect.`,
      () => `The setup instructions for the new router don't match what I'm seeing.`,
    ],
    returnOpen: [
      (c) => `Still having trouble with the new router. I chatted with you ${c.v.prevWhen}.`,
      () => `The router setup still isn't working. Need help again.`,
    ],
    probes: [
      [
        () => `What do the lights on the router look like right now?`,
        () => `The power light is on and the internet light is blinking orange.`,
      ],
      [
        () => `Did you activate the router in the app or on the website first?`,
        () => `I didn't know I had to activate it.`,
      ],
    ],
    troubleshoot: [
      [
        () => `Please make sure the coax cable is connected to the port labeled "Cable In".`,
        () => `Yes, it's in the right port.`,
      ],
      [
        () => `Try restarting the router and waiting 5 minutes for it to finish setting up.`,
        () => `I waited 10 minutes. Still blinking.`,
      ],
    ],
    fix: [
      () =>
        `I've activated the new router on your account using its serial number. The light should turn solid white in a minute or two.`,
      () =>
        `The old router was still registered to your account. I've swapped it for the new one, so give it a minute.`,
    ],
    confirm: [() => `Solid white now, and I'm connected. Thanks!`, () => `It works! Wi-Fi is up.`],
    falseFix: [
      () => `I've activated your new router. It should be working now!`,
      () => `Your router is all set up on our end. Enjoy your service!`,
    ],
    cantFix: [
      () =>
        `This router may be defective. I've ordered a replacement and it will arrive in 3 to 5 days.`,
      () =>
        `I'd recommend a technician visit for the install. I've opened a request and someone will call to schedule.`,
    ],
  },

  // ───────────── account_changes ─────────────
  {
    id: 'plan_change',
    businessLine: 'account_changes',
    summary: 'Change plan (upgrade or downgrade)',
    open: [
      (c) => `I'd like to switch from ${c.v.plan} to ${c.v.newPlan}.`,
      (c) => `Hi, can I downgrade my plan? ${c.v.plan} is more than I need.`,
      (c) => `How do I upgrade to ${c.v.newPlan}? The website won't let me.`,
    ],
    returnOpen: [
      (c) =>
        `I asked to change my plan to ${c.v.newPlan} ${c.v.prevWhen} but my account still shows ${c.v.plan}.`,
      () => `My plan change never went through. I already requested it once.`,
    ],
    probes: [
      [() => `Sure! Can you confirm the account holder's name?`, (c) => `${c.name()}.`],
      [
        () =>
          `Do you want the change to take effect now or at the start of your next billing cycle?`,
        () => `Right away if possible.`,
      ],
    ],
    troubleshoot: [
      [
        (c) =>
          `It looks like ${c.v.newPlan} needs a newer modem. Do you have the model number of yours?`,
        () => `I don't know, it's whatever you sent me two years ago.`,
      ],
      [
        () => `There's a contract on your current plan. Would you be okay with a $20 change fee?`,
        () => `No, I wasn't told about any fee when I signed up.`,
      ],
    ],
    fix: [
      (c) =>
        `Done. You're now on ${c.v.newPlan}, effective today. Your next bill will be ${c.v.newAmount}, and a confirmation is on its way to your email.`,
      (c) =>
        `I've switched you to ${c.v.newPlan} and waived the change fee. Confirmation number ${c.v.ref}.`,
    ],
    confirm: [
      (c) => `Great, I see ${c.v.newPlan} on my account now. Thanks.`,
      () => `Got the confirmation email. Perfect.`,
    ],
    falseFix: [
      (c) => `Your plan has been updated to ${c.v.newPlan}! The change is complete.`,
      () => `All done! Your plan change has been processed.`,
    ],
    cantFix: [
      (c) => `${c.v.newPlan} isn't available at your address yet. I can put you on a waitlist.`,
      () =>
        `Plan changes in a contract period have to be handled by our retention team. I've sent them a note to call you.`,
    ],
  },
  {
    id: 'update_address',
    businessLine: 'account_changes',
    summary: 'Move service to a new address',
    open: [
      (c) => `I'm moving next month and need to transfer my service to ${c.newAddress()}.`,
      () => `Hi, I need to update my service address. I'm moving.`,
      (c) => `Can you move my account from ${c.address()} to my new place?`,
    ],
    returnOpen: [
      (c) => `I set up my move ${c.v.prevWhen} but there's no service at the new address.`,
      () => `My address change didn't go through. I already did this once.`,
    ],
    probes: [
      [() => `Congrats on the move! What's the new address?`, (c) => `${c.newAddress()}.`],
      [
        () => `What date would you like service to start at the new address?`,
        () => `The 1st of next month.`,
      ],
      [
        () => `And what's the phone number we should use for the installer?`,
        (c) => `${c.phone()}.`,
      ],
    ],
    troubleshoot: [
      [
        () => `I'm not finding that address in our system. Could you double-check the unit number?`,
        () => `There's no unit number, it's a house.`,
      ],
      [
        () => `Is there a different ZIP code you might have used before?`,
        () => `No, that's the right ZIP.`,
      ],
    ],
    fix: [
      (c) =>
        `Your service is scheduled to transfer to the new address on the 1st. Confirmation number ${c.v.ref}, and the installer will text you the day before.`,
      () => `All set. The move is booked, and service at your current address ends the same day.`,
    ],
    confirm: [
      () => `Got the confirmation text. Thanks!`,
      () => `Perfect, I can see the move date on my account.`,
    ],
    falseFix: [
      () => `I've updated your address. Your service will be ready at your new home!`,
      () => `Your move has been completed in our system. You're all set!`,
    ],
    cantFix: [
      () =>
        `We don't offer service at that address yet. I'm sorry, but I can help you schedule a cancellation.`,
      () =>
        `I'm not able to schedule installs more than 30 days out. Please contact us again closer to your move date.`,
    ],
  },
  {
    id: 'add_user',
    businessLine: 'account_changes',
    summary: 'Add an authorized user to the account',
    open: [
      (c) => `I want to add my partner, ${c.other()}, as an authorized user on my account.`,
      () => `How do I add someone to my account so they can call in about it?`,
      (c) =>
        `Hi, can ${c.other()} be added to the account? They keep getting told they're not authorized.`,
    ],
    returnOpen: [
      (c) => `I added ${c.other()} to my account ${c.v.prevWhen} but they still can't access it.`,
      () => `Authorized user still not showing up. I already requested this.`,
    ],
    probes: [
      [() => `Sure. What's the full name of the person you'd like to add?`, (c) => `${c.other()}.`],
      [() => `I'll need to verify you first. What's the account number?`, (c) => `${c.account()}.`],
    ],
    troubleshoot: [
      [
        () => `They'll need to accept an invitation sent to their email. Did they get it?`,
        () => `They said they didn't get anything.`,
      ],
      [
        () => `Could you try adding them from the Account > Users page in the app?`,
        () => `The add user button is grayed out.`,
      ],
    ],
    fix: [
      (c) =>
        `${c.other()} is now an authorized user and can manage the account. I've sent you both a confirmation.`,
      () => `Done. They're added with full access, effective immediately.`,
    ],
    confirm: [
      () => `They just texted me that they got the email. Thanks!`,
      () => `I see them listed on the account now. Great.`,
    ],
    falseFix: [
      () => `The authorized user has been added! They can now access the account.`,
      () => `All set, I've updated your account with the new user.`,
    ],
    cantFix: [
      () =>
        `The person being added has to call in themselves to verify their identity. I can't complete this over chat.`,
      () => `Your account type only supports one user. You'd need to upgrade to a family plan.`,
    ],
  },
  {
    id: 'cancel_service',
    businessLine: 'account_changes',
    summary: 'Cancel a service or add-on',
    open: [
      () => `I want to cancel the TV add-on. I never use it.`,
      () => `Please cancel my streaming bundle, effective this billing cycle.`,
      () => `Hi, how do I cancel the premium support add-on? I can't find it in the app.`,
    ],
    returnOpen: [
      (c) => `I cancelled the add-on ${c.v.prevWhen} and I'm still being charged for it.`,
      () => `I asked you to cancel an add-on and it's still on my bill.`,
    ],
    probes: [
      [
        () => `I can help with that. Can you confirm the email address on the account?`,
        (c) => `${c.email()}.`,
      ],
      [
        () => `May I ask why you'd like to cancel?`,
        () => `I just don't use it. It's a waste of money.`,
      ],
    ],
    troubleshoot: [
      [
        () =>
          `Before you go, I can offer 50% off the add-on for 6 months. Would you like that instead?`,
        () => `No thanks, I just want it cancelled.`,
      ],
      [
        () => `I can give you a free month to try the new features. Interested?`,
        () => `No. Please just cancel it.`,
      ],
    ],
    fix: [
      () =>
        `I've cancelled the add-on effective today, and you'll get a prorated credit on your next bill.`,
      (c) =>
        `Done. The add-on is removed and you won't be charged for it again. Reference ${c.v.ref}.`,
    ],
    confirm: [
      () => `Thanks, I see it's removed from my services list.`,
      () => `Great, got the cancellation email.`,
    ],
    falseFix: [
      () => `Your add-on has been cancelled! You won't see it on future bills.`,
      () => `All done. The cancellation has been processed.`,
    ],
    cantFix: [
      () =>
        `That add-on is part of a bundle and can't be cancelled on its own. You'd have to change your whole plan.`,
      () =>
        `Cancellations have to go through our retention team. I've requested a callback for you.`,
    ],
  },
  {
    id: 'update_payment_method',
    businessLine: 'account_changes',
    summary: 'Update the payment method on file',
    open: [
      () => `I got a new card and need to update my autopay.`,
      (c) => `Can you update the card on my account? The old one ending in ${c.card()} expired.`,
      () => `Hi, I'm trying to change my payment method and the site keeps rejecting my new card.`,
    ],
    returnOpen: [
      (c) => `I updated my card ${c.v.prevWhen} but autopay tried the old card again.`,
      () => `My payment method still isn't updated. Second time asking.`,
    ],
    probes: [
      [
        () => `For security, can you confirm the phone number on the account?`,
        (c) => `${c.phone()}.`,
      ],
      [
        () => `What error do you see when you add the new card?`,
        (c) => `It just says "invalid card" (${c.v.errorCode}).`,
      ],
    ],
    troubleshoot: [
      [
        () => `Can you make sure the billing address you're entering matches your card statement?`,
        (c) => `It does. ${c.address()}.`,
      ],
      [
        () => `Could you try removing the old card first and then adding the new one?`,
        () => `It won't let me remove the old card because it's on autopay.`,
      ],
    ],
    fix: [
      () =>
        `I've removed the expired card and turned off autopay temporarily. Please add the new card now, and I'll turn autopay back on.`,
      () =>
        `There was a validation bug on our side. I've added the card to autopay manually and it's set as your default now.`,
    ],
    confirm: [
      () => `The new card shows as the default now. Thanks!`,
      () => `It worked. Autopay is set up with the new card.`,
    ],
    falseFix: [
      () => `Your payment method has been updated! Autopay will use the new card going forward.`,
      () => `All set! Your card information is now current.`,
    ],
    cantFix: [
      () =>
        `Our payment system can't accept that card type. You'd need a different card or a bank account.`,
      () => `I'm not able to edit payment details over chat. Please call the billing line.`,
    ],
  },
];

export const GOALS_BY_LINE: Record<BusinessLine, readonly Goal[]> = {
  billing: GOALS.filter((g) => g.businessLine === 'billing'),
  tech_support: GOALS.filter((g) => g.businessLine === 'tech_support'),
  account_changes: GOALS.filter((g) => g.businessLine === 'account_changes'),
};

// ───────────── shared lines ─────────────

export const AI_GREET: readonly Line[] = [
  () => `Hi there! I'm the virtual assistant, and I can help with that.`,
  () => `Thanks for reaching out! I'm an automated assistant. Let's get this sorted.`,
  () => `Hello! I'm the virtual assistant and I'm happy to help.`,
];

export const HUMAN_GREET: readonly Line[] = [
  (c) => `Hi, thanks for contacting us, this is ${c.agent()}.`,
  (c) => `Hello, my name is ${c.agent()} and I'll be helping you today.`,
  (c) => `Thanks for waiting! I'm ${c.agent()}.`,
];

/** Agent asks to verify → customer answers with PII. */
export const VERIFY: readonly (readonly [Line, Line])[] = [
  [
    () => `To pull up your account, can you give me the email address or phone number on file?`,
    (c) => `Sure, it's ${c.email()}.`,
  ],
  [() => `Before we start, could you confirm your account number?`, (c) => `It's ${c.account()}.`],
  [() => `What's the full name and email on the account?`, (c) => `${c.name()}, ${c.email()}.`],
  [
    () => `Can I get the account number and the phone number on the account?`,
    (c) => `${c.account()}, and the phone is ${c.phone()}.`,
  ],
  [
    () => `Can you confirm the name and service address on the account?`,
    (c) => `${c.name()}, ${c.address()}.`,
  ],
];

export const EFFORT_FRICTION: readonly (readonly [Line, Line])[] = [
  [
    () => `Can you confirm your account number again for me?`,
    (c) => `I already gave it to you. It's ${c.account()}.`,
  ],
  [
    () => `Let me put you on a brief hold while I check with my team.`,
    () => `Okay... it's been a while.`,
  ],
  [
    () => `Can you describe the issue one more time from the beginning?`,
    () => `This is the third time I've explained this. Fine.`,
  ],
  [
    () => `I'm going to need to verify your identity again.`,
    (c) => `Seriously? ${c.email()}. Again.`,
  ],
];

export const ANYTHING_ELSE: readonly Line[] = [
  () => `Is there anything else I can help you with today?`,
  () => `Anything else I can do for you?`,
];
export const NO_THANKS: readonly Line[] = [
  () => `No, that's all. Thanks.`,
  () => `Nope, that's it.`,
  () => `No, thank you.`,
];
export const GOODBYE: readonly Line[] = [
  () => `Thanks for reaching out, and have a great day!`,
  () => `Glad I could help. Take care!`,
];
export const ACCEPT_CLAIM: readonly Line[] = [
  () => `Oh okay, great. Thanks.`,
  () => `Okay, thank you.`,
  () => `Alright, thanks for the help.`,
];
export const FRUSTRATED: readonly Line[] = [
  () => `So I just have to wait? This is really frustrating.`,
  () => `That's not a solution. I've been dealing with this for days.`,
  () => `Okay. I guess I don't have a choice.`,
  () => `Unbelievable.`,
];
export const SORRY_CLOSE: readonly Line[] = [
  () => `I'm sorry for the inconvenience. Is there anything else I can help with?`,
  () => `I understand, and I apologize. We'll be in touch.`,
];

/** Customer asks to leave the AI (or the human agent) for someone else. */
export const ASK_HUMAN: readonly Line[] = [
  () => `Can I talk to a real person please?`,
  () => `I want to speak to a human. This isn't helping.`,
  () => `Agent. Representative. Human.`,
  () => `Is there a person I can talk to? You're not understanding my problem.`,
];
export const ASK_SUPERVISOR: readonly Line[] = [
  () => `I'd like to speak to a supervisor.`,
  () => `Can you escalate this to your manager?`,
];
export const AI_ESCAPE_RESPONSE: readonly Line[] = [
  (c) =>
    `I understand. I've created a request (${c.v.ref}) and a specialist will reach out within 24 to 48 hours.`,
  () =>
    `Live agents are currently unavailable. I've scheduled a callback for you during business hours.`,
  () => `I'll pass this to our support team. Someone will contact you by email.`,
];
export const SUPERVISOR_RESPONSE: readonly Line[] = [
  () =>
    `I understand. A supervisor isn't available right now, but I've requested a callback within 24 hours.`,
  (c) =>
    `I'll escalate this to my supervisor. They'll call you back, and your reference is ${c.v.ref}.`,
];
export const ESCAPE_REACTION: readonly Line[] = [
  () => `Fine.`,
  () => `Whatever. Okay.`,
  () => `24 to 48 hours?? Ugh.`,
];

export const handoffAi = (team: string): readonly Line[] => [
  () =>
    `I'm going to connect you with a specialist on our ${team} team who can help with this. One moment please.`,
  () => `This needs a specialist from ${team}. I'm transferring you now, please stay in the chat.`,
];
export const HANDOFF_ACK: readonly Line[] = [() => `Okay.`, () => `Thanks.`, () => `Finally.`];
export const HANDOFF_WAIT: readonly Line[] = [
  () => `You're in the queue for a specialist. Current wait time is about 15 minutes.`,
  () => `All of our specialists are busy. Your estimated wait is 20 minutes.`,
];
export const HUMAN_AFTER_HANDOFF: readonly Line[] = [
  (c) =>
    `Hi ${c.first()}, this is ${c.agent()}. I've read through your conversation with the assistant.`,
  (c) => `Hello, ${c.agent()} here. Thanks for your patience. I can see what you've tried so far.`,
  (c) => `Hi, I'm ${c.agent()}. Sorry for the wait. Let me take a look.`,
];
