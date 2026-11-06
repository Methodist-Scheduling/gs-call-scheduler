// Plain-English rules (rules v1.3) plus what the app actually checks. Shown on the Rules tab and in the Rule check popups.
// No names here: this repo is public. Names that matter (exceptions, leave) live in the database.
window.RULES_CATALOG = {
  version: 'v1.3',
  groups: [
    { id: 'T0', title: 'ACGME limits', tier: 'Never broken',
      intro: 'Federal duty-hour limits. The app will not hand the PD a schedule that breaks them.',
      rules: [
        { id: 'ACGME', title: 'Duty hours', plain: '80 hours a week (4-week average), 1 day in 7 off, in-house call no more than every 3rd night, 24 hours of continuous duty plus up to 4 for handoff, 14 hours off after a 24-hour call.',
          computer: 'Counts each resident\'s calls on a rolling 28 days and flags anyone over every-3rd-night. Call length is a setting (default 24 h). The 80-hour check needs rotation hours, which aren\'t loaded yet.' }
      ] },
    { id: 'T1', title: 'Hard rules', tier: 'The app won\'t break these',
      intro: 'Program rules that are always met. If a month can\'t meet one, the Rule check names the rule and the day. Hand edits can still break them (the cell turns red).',
      sections: [
        { title: 'Who is on each call', rules: [
          { id: 'H1', title: 'One intern every day', plain: 'Every call day has exactly one intern, including two-person call.', computer: 'Intern slot can never be empty; only PGY-1s can fill it.' },
          { id: 'H2', title: 'Three-person call', plain: 'Normal call is an intern, a mid level (PGY-2/3) and an upper level (PGY-4/5 or fellow). A PGY-4 never fills the mid slot.', computer: 'Upper slot: PGY-4, PGY-5, fellow (and PGY-3s placed by hand Jan–Jun). Mid slot: PGY-2 or PGY-3 only.' },
          { id: 'H3', title: 'Two-person call', plain: 'An upper level + an intern, no mid. Only when short-staffed, never planned. The fellow and PGY-5s don\'t take it (unless a chief places a PGY-5). Some PGY-4s can be marked not eligible.', computer: 'Two-person days cost the score, so the app only uses them when nothing else works. Upper must be a PGY-4 who isn\'t on the not-eligible list (Rules tab setting, chief only).' },
          { id: 'H4', title: 'No two-person Fri/Sat', plain: 'Never on Friday or Saturday. Sunday only if a scheduler or chief allows it that day.', computer: 'Two-person call on a Friday or Saturday is a hard break.' },
          { id: 'H5', title: 'No same year twice', plain: 'Two residents of the same PGY year are never on call the same day.', computer: 'Compares the PGY of all three slots each day.' },
          { id: 'H6', title: 'PGY-3s', plain: 'PGY-3s take mid-level call all year. From January, a scheduler or chief may put one in the upper slot. The app never does that on its own.', computer: 'PGY-3s are only offered for the upper slot by hand, Jan–Jun.' },
          { id: 'H7', title: 'Fellow', plain: 'The fellow only takes the upper slot, 4 calls a month by default.', computer: 'Fellow calls over the cap (Rules tab) are a hard break unless the fellow picked them.' }
        ] },
        { title: 'Who is eligible', rules: [
          { id: 'H8', title: 'Not in the pool', plain: 'Off-site and excluded rotations (Richardson, Peds, Transplant), leave, and the resident\'s vacation week (Mon–Fri) are never on call.', computer: 'Those days are blocked for that person. Leave dates come from Inputs.' },
          { id: 'H9', title: 'Weekend callers round', plain: 'Whoever takes Friday, Saturday or Sunday call is working that weekend and rounds.', computer: 'Fri–Sun callers are placed on the weekend rounding teams first.' },
          { id: 'H10', title: 'PGY-5 and fellow picks', plain: 'PGY-5s and the fellow choose their own call dates. Those are locked before anything else.', computer: 'Picks entered on Inputs become locked upper-slot cells.' },
          { id: 'H11', title: 'Holiday list is locked', plain: 'The holiday Working list is followed exactly. It (and the picks above) win over the weekend alternation in W3 and W6.', computer: 'Holiday days are locked cells; the ICU and T/EGS alternation is chosen to fit around locked dates.' }
        ] },
        { title: 'Spacing', rules: [
          { id: 'H13', title: 'Never two days in a row', plain: 'A post-call day always sits between calls.', computer: 'Same person on day d and d+1 is a hard break.' },
          { id: 'H14', title: 'Every-other-day limit', plain: 'At most 3 calls in a row on an every-other-day pattern.', computer: 'Longest chain of calls 2 days apart can\'t exceed the limit (Rules tab).' },
          { id: 'H15', title: 'Sister services', plain: 'Trauma and EGS residents are never on call the same day; same for Vascular and Thoracic.', computer: 'Checks rotations of everyone on call each day.' },
          { id: 'H16', title: 'Coverage partners', plain: 'If the ICU fellow or the ICU resident is away, the other isn\'t post-call on a weekday. Same for the Trauma/EGS residents who are PGY-3 and up.', computer: 'A call the night before a Mon–Fri day when the partner is on vacation or leave is a hard break.' }
        ] }
      ] },
    { id: 'T2', title: 'Strong goals', tier: 'Broken only when nothing else works',
      intro: 'The app tries hard to meet these. Every miss shows in the Rule check and on Stats, with dates.',
      rules: [
        { id: 'S1', title: 'Avoid every-other-day call', plain: 'Keep q2 call (call, post-call, call) as rare as possible.', computer: 'Each every-other-day gap costs points.' },
        { id: 'S2', title: 'Protected time', plain: 'Nobody is post-call on an exam or protected event (Mock ABSITE, boards, Step 3, ATLS…).', computer: 'Call the night before a protected date costs heavily.' },
        { id: 'S3', title: 'Colorectal days', plain: 'The GS2 resident isn\'t post-call on big colorectal days (most Mondays and Wednesdays). Dates marked on Requests are firm.', computer: 'Marked dates are hard. Unmarked: GS2 call on Sunday or Tuesday night costs points.' },
        { id: 'S4', title: 'Vacation bookends', plain: 'The weekends before and after a vacation week are off, for 9 days in a row. At least one of the two if both can\'t be.', computer: 'Weekend call next to a vacation costs points.' },
        { id: 'S5', title: 'A weekend off', plain: 'Everyone gets at least one full weekend (Fri–Sun) off a month. Call or rounding both count as working.', computer: 'A month with zero weekends off costs heavily.' },
        { id: 'S6', title: 'Requests', plain: 'Accepted day-off and want-call requests are honored when possible. Requests the PD adds are always honored.', computer: 'Each missed request costs points. PD requests become blocked days or locked calls.' },
        { id: 'S7', title: 'No back-to-back weekends', plain: 'Avoid working two weekends in a row (call or rounding), including the last weekend of the month before.', computer: 'Each pair of consecutive worked weekends costs points.' }
      ] },
    { id: 'T3', title: 'Fairness goals', tier: 'Balanced over the month and the year',
      intro: 'Spread the load evenly. Someone who carried extra last month gets relief this month.',
      rules: [
        { id: 'F1', title: 'Call targets', plain: 'Each resident lands in their group\'s monthly range (set on this tab). Vacation doesn\'t shrink the target; maternity leave does and is never owed back.', computer: 'Each call under or over the range costs points.' },
        { id: 'F2', title: 'Two weekends off', plain: 'Ideally two weekends off a month.', computer: 'Only one weekend off costs a little.' },
        { id: 'F3', title: 'Weekend and holiday balance', plain: 'Weekend and holiday call spread evenly within each group, year to date.', computer: 'Compares year-to-date weekend counts inside each group.' },
        { id: 'F4', title: 'Two-person balance', plain: 'Two-person call shared evenly among PGY-4s.', computer: 'Uneven two-person counts cost a little.' },
        { id: 'F5', title: 'Mix of call types', plain: 'An even mix of weekday, Friday, Saturday and Sunday call.', computer: 'Tracked on Stats.' },
        { id: 'F6', title: 'Spread out', plain: 'Calls spread across the month, ideally 3+ days apart.', computer: 'Short gaps cost a little.' }
      ] },
    { id: 'TW', title: 'Weekend rounding', tier: 'How weekend teams are made',
      intro: 'Each weekend has six rounding teams: Trauma/EGS, ICU, GS1, GS2, Vasc/Thor and HPB/Transplant. Schedulers can edit any team by hand on the Schedule tab.',
      rules: [
        { id: 'W1', title: 'Own service first', plain: 'Residents round on their own service. If nobody from a service is on call that weekend, one person from it is pulled in, taking turns. If that person worked the weekend before, a cross-covering caller covers instead.', computer: 'Fill-ins skip anyone who worked last weekend when a caller is free, then rotate by fewest fill-ins.' },
        { id: 'W2', title: 'HPB/Transplant', plain: 'One resident covers both HPB and Transplant. Two (one each) when there are 4+ residents across both services.', computer: 'Splits the block only when it can\'t cause a back-to-back weekend.' },
        { id: 'W3', title: 'ICU alternation', plain: 'The ICU fellow and the ICU resident take turns: the fellow rounds ICU two weekends a month, the resident the others. On your off weekend you\'re fully off, no call either.', computer: 'Locked dates decide whose weekend it is. Call on your off weekend is a hard break.' },
        { id: 'W4', title: 'Saturday matches Sunday', plain: 'The same teams round Saturday and Sunday unless a scheduler changes them.', computer: 'One team list per weekend.' },
        { id: 'W5', title: 'Callers round', plain: 'Friday, Saturday and Sunday callers come from that weekend\'s teams (same as H9).', computer: 'See H9.' },
        { id: 'W6', title: 'T/EGS alternation', plain: 'The Trauma and EGS residents who are PGY-3 and up take turns rounding T/EGS, each with a PGY-1 or PGY-2 (an intern if possible). On your off weekend you\'re fully off, no call either.', computer: 'Locked dates decide whose weekend it is. Call on your off weekend is a hard break.' }
      ] },
    { id: 'TH', title: 'Holidays', tier: 'Locked from the Vacation and Holiday Schedule',
      intro: 'Holiday call follows the published Working list.',
      rules: [
        { id: 'HD1', title: 'Working', plain: '"Working" means on call that day. Those cells are locked first.', computer: 'Locked cells.' },
        { id: 'HD2', title: 'Backup', plain: '"Backup" is called in if a Working resident calls out. Each use is recorded for fairness.', computer: 'Recorded on the activity log.' },
        { id: 'HD3', title: 'Trios', plain: 'Christmas: one trio takes Dec 23, 25, 27, the other Dec 24, 26. New Year\'s: Dec 30, Jan 1, 3 and Dec 31, Jan 2. A scheduler or chief picks which trio starts.', computer: 'The six Working names are split into two valid trios; "Swap start" flips them.' },
        { id: 'HD5', title: 'Holiday rounding', plain: 'On a holiday (and a holiday weekend), only the people on call that day round. Each is assigned a service, their own when possible. Everyone else is off: nobody is pulled in, and the ICU and T/EGS alternation pauses.', computer: 'Holiday days build rounding from that day’s callers only, own service first, then the empty services.' },
        { id: 'HD4', title: 'Counts toward targets', plain: 'Holiday call counts toward monthly targets and the weekend/holiday balance.', computer: 'Included in F1 and F3.' }
      ] },
    { id: 'TA', title: 'Approval and swaps', tier: 'Nothing goes out without the PD',
      intro: 'Every version is kept. The database enforces these steps, not just the screen.',
      rules: [
        { id: 'A1', title: 'Steps', plain: 'Draft → Scheduler review → PD review → Approved → Published. The PD approves and publishes, approves and hands it back for the schedulers to publish, or sends it back with comments.', computer: 'Each move is checked by role in the database and logged with who and when.' },
        { id: 'A2', title: 'What residents see', plain: 'Residents only ever see published schedules (current and past). They\'re alerted at sign-in when a new month is out or when their own calls or rounding change.', computer: 'Residents read published copies only; drafts are admin-only.' },
        { id: 'SW0', title: 'How residents trade', plain: 'On a published schedule, a resident clicks their own call and picks a trade. The other resident agrees or declines; if they agree, a scheduler or chief approves or denies. Everyone involved is told at their next sign-in. Trades only for now (no giving a call away).', computer: 'Swaps live in their own table; residents only see swaps they are part of. Approval re-checks every rule with full data and cancels the swap if either call changed.' },
        { id: 'SW1', title: 'Like for like', plain: 'Swaps trade weekday for weekday, Friday for Friday, weekend for weekend.', computer: 'Only same-type days are offered.' },
        { id: 'SW2', title: 'Checked first', plain: 'A swap is only offered if it keeps every hard rule.', computer: 'Each candidate swap is scored before it\'s listed.' },
        { id: 'SW3', title: 'Who approves', plain: 'A scheduler or PGY-5 chief approves swaps. The PD isn\'t involved. Swaps count toward year-to-date totals.', computer: 'Swaps on a published month create a revised version and alert the residents involved.' }
      ] }
  ],
  guide: [
    { title: 'Each month, in order', steps: [
      'Inputs: fix anything that changed: rotations, vacations, leave, PGY-5 and fellow picks.',
      'Requests: accept or deny incoming requests and paste texted ones for Claude to read. Accepting asks whether to rebuild now.',
      'Schedule: click Generate fresh draft (or Regenerate around locks to keep your edits). Read the Rule check; click any line for dates.',
      'Fix things by hand: click any call to replace it, lock it, or swap it. Red names break a rule; you can still pick them. Edit weekend rounding teams below the calendar.',
      'Stats: check targets, weekends off and fairness. Click any "area for improvement" for a calendar.',
      'Approval: Save version, then Send to the PD.'
    ] },
    { title: 'The PD', steps: [
      'Approval tab: Approve and publish, Approve and send to schedulers (they publish when ready), or Send back with a comment.',
      'Requests: anything you add is always honored ("off" becomes unavailable, "wants call" becomes a locked call).'
    ] },
    { title: 'After publishing', steps: [
      'Residents see it right away and get an alert at their next sign-in.',
      'Swaps: click a name on the Schedule, pick a like-for-like swap. It becomes a revised version and the people involved are alerted.',
      'Residents can request trades themselves: they show up on Requests under Swaps once the other resident agrees. Approve or deny with a reason.',
      'Bigger changes: Approval → Start a revised version, edit, and send to the PD again.'
    ] },
    { title: 'People and roster', steps: [
      'People: add someone by name, roster name and role. Email is optional: uncheck "Email them" to copy a one-time link instead. Open test links in a private window.',
      'Call roster (bottom of People): change levels, remove people who left, add new people from a given month.',
      'Schedulers, chiefs and the PD are always admins. Turn Active off to block sign-in but keep the account; Delete removes it for good.'
    ] },
    { title: 'Changing a rule', steps: [
      'Numbers (call targets, fellow cap, every-other-day limit, call length) are editable on this tab, then Rebuild with these rules.',
      'Anything else is a rules change: update the rules doc (new version), get PD sign-off, then the app is updated to match.'
    ] }
  ]
};
