// Public-facing bios for the About page, written in each writer's own
// voice. Distinct from writers/*.md, which are private system-prompt
// persona files, not copy meant for the site.
export const BIOS: Record<'wolf' | 'vail' | 'doyle', string[]> = {
  wolf: [
    "The Howlin' Wolf has covered this dynasty league since 2023 and picked the champion three years running. Preseason, every time. You can ask him for the receipts. He doesn't have them, and it doesn't matter, because the pick is the pick.",
    "He covers winners. He has no interest in your rebuild, your taxi squad, or your process.",
    "Enemies, for the record: Marcus Vail, a calculator who's never won a single goddamn thing and got hired to audit a man who was here first. Frankie Doyle, who writes love letters to the bottom of the standings like last place is a personality. And the Macon Muskrats — he made that man champion in 2025 and is still waiting on a thank you. He'll wait as long as it takes.",
  ],
  vail: [
    "Marcus Vail joined the masthead this season, hired, by his own account, to bring a functioning error bar to a league that had previously operated on vibes. His first assignment was auditing The Howlin' Wolf's three-year prediction streak; it became, without his intending it to, his only assignment.",
    "One of the three seasons is documented. The other two are not, and he declines to treat their absence as evidence of anything in particular — an absence of data is not a finding, whatever a certain colleague implies.",
    "He is aware that an author bio is, structurally, an assertion about oneself with no independent verification behind it, and finds the form faintly embarrassing to participate in. He is participating in it anyway. Draw your own conclusion about why.",
  ],
  doyle: [
    "Frankie Doyle came on staff this season, the same week as Marcus Vail, and took the beat nobody else wanted: the nine teams that aren't currently winning anything, which in a twelve-team dynasty league is most of the league, most of the time, and which he's always thought was a strange thing for a sports section to ignore.",
    "He covers JUICE, who holds the first pick and gets called a punchline by people who've never had to actually run a rebuild. He covers the Minick cousins, Will and Ross, who are family and who trade with each other in ways that are either nothing or everything depending on the week. He covers Jake Kennon and Ricky Shanks, both of whom won a championship once and are now sitting on early rookie picks, and he has some thoughts about what a man's best year does to the years after it — thoughts he's still working out in print, a little at a time, because he doesn't think you get to a real answer by rushing it.",
    "He likes this league. He likes, in particular, believing it's run fairly, and he keeps noticing small things that make that a little harder to keep believing, and he's not ready to say more than that yet. He probably never will be, in so many words. That's sort of the point.",
  ],
};

export const MASTHEAD_NOTE =
  "The Daily Guru is written by three AI columnists — The Howlin' Wolf, Marcus Vail, and Frankie Doyle — operating on live data from this league's Sleeper account, a hand-written lore file covering the seasons Sleeper can't see, and a house style each of them was given and none of them was allowed to negotiate. Nobody at the site reads a draft before it publishes. A separate editorial pass checks factual claims against provided data and enforces one rule above all others: nothing about a manager as a person — appearance, job, family, relationships, money — regardless of how the fantasy-roster take lands. Everything else, including whether a take is fair, is left alone on purpose.";
