// Fictional rivalries and story premises: understandable without knowing AI or code.
const t = (label, title, a, b) => ({ label, title, a, b });
export const TOPICS = {
  rap: [
    t(
      "Fake flex vs real money",
      "A fake-rich influencer vs the friend who knows they are broke",
      "the influencer renting a luxury lifestyle for the camera",
      "the friend who has seen the unpaid bills",
    ),
    t(
      "The ex vs the upgrade",
      'The ex who says "you will never do better" vs the one who did',
      "the ex insisting they were the best thing that ever happened",
      "the ex who moved on and has the receipts",
    ),
    t(
      "Gym bro vs couch king",
      "The gym bro who never skips leg day vs the couch potato living their best life",
      "the fitness obsessive making everything a workout",
      "the proudly lazy friend who refuses to feel guilty",
    ),
    t(
      "Hustle culture vs sleep",
      "The 5 AM hustle guru vs the person who actually enjoys their life",
      "the motivational hustle guru selling nonstop grind",
      "the well-rested rival who thinks your alarm is the real enemy",
    ),
    t(
      "Clout vs actual talent",
      "The viral influencer vs the talented nobody who is tired of being ignored",
      "the influencer who knows how to get attention",
      "the unknown artist with actual skill and something to prove",
    ),
    t(
      "Money vs main character",
      "The rich kid with a safety net vs the broke friend with main-character confidence",
      "the rich kid who thinks money solves everything",
      "the broke but resourceful friend who owns every room",
    ),
    t(
      "Wedding DJ vs angry neighbor",
      "The wedding DJ at full volume vs the neighbor who has work tomorrow",
      "the wedding DJ who believes every street is a dance floor",
      "the furious neighbor trying to sleep before an early shift",
    ),
    t(
      "City swagger vs small-town pride",
      "Big-city swagger vs the small-town cousin who refuses to be impressed",
      "the city cousin flexing nightlife, fashion and connections",
      "the small-town cousin exposing the cost and pretence",
    ),
    t(
      "Party friend vs responsible one",
      'The friend who says "one more night out" vs the one paying for every bad decision',
      "the party friend turning every Tuesday into an event",
      "the responsible friend who always has to clean up",
    ),
    t(
      "Designer drip vs thrift-store fire",
      "Designer labels vs the thrift-store outfit that stole the whole party",
      "the fashion rival buying status through expensive labels",
      "the thrift shopper whose cheap outfit gets all the attention",
    ),
    t(
      "Street food vs fine dining",
      "The street-food legend vs the celebrity chef charging for an empty plate",
      "the street-food cook serving flavor without the performance",
      "the fine-dining chef defending craft, prestige and tiny portions",
    ),
    t(
      "Family favorite vs family rebel",
      "The family golden child vs the rebel who finally says what everyone is thinking",
      "the polished family favorite who can do no wrong",
      "the outspoken family rebel tired of the double standard",
    ),
  ],
  roast: [
    t(
      "The friend who never pays back",
      'The friend who borrows money for "two days" vs the one who still has the screenshot',
      "the serial borrower with a new excuse every week",
      "the lender with the screenshots and no patience left",
    ),
    t(
      "The situationship showdown",
      'The "not ready for a relationship" person vs the ex who found their wedding invite',
      "the commitment dodger whose excuses have caught up with them",
      "the ex holding a very inconvenient wedding invitation",
    ),
    t(
      "Fake life, real receipts",
      "The lifestyle influencer whose luxury apartment is actually their parents' living room",
      "the influencer performing a luxury lifestyle at home",
      "the skeptical friend who knows what is behind the camera",
    ),
    t(
      "Wedding guest main character",
      "The wedding guest who tries to make somebody else's big day all about them",
      "the attention-seeking guest who thinks the wedding is their red carpet",
      "the bride or groom finally calling out the guest",
    ),
    t(
      "The group-project freeloader",
      "The group-project freeloader vs the person who did all the work",
      'the freeloader whose contribution was "great job team"',
      "the exhausted teammate who carried the whole project",
    ),
    t(
      "The podcast philosopher",
      "The person who bought a microphone and immediately became a relationship expert",
      "the self-appointed podcast relationship guru",
      "the friend who remembers the guru's own romantic disasters",
    ),
    t(
      "The ghoster comes back",
      'The person who ghosted you for six months and returns with "hey stranger"',
      "the shameless ghoster treating six months like six minutes",
      "the person whose peace was interrupted by that text",
    ),
    t(
      "The gym selfie professional",
      "The gym influencer who spends more time choosing angles than lifting weights",
      "the influencer treating the gym as a photo studio",
      "the regular gym member waiting for the machine",
    ),
    t(
      "The unsolicited life coach",
      "The cousin with no plan who gives everyone career and marriage advice",
      "the cousin offering loud advice from a messy life",
      "the relative who finally asks for proof it works",
    ),
    t(
      "The terrible roommate",
      "The roommate who labels their milk but eats all your food",
      "the territorial roommate with selective respect for boundaries",
      "the roommate keeping a list of every missing meal",
    ),
    t(
      "The luxury birthday wishlist",
      "The friend who sends a luxury birthday wishlist but gives everyone a free e-card",
      "the birthday diva with very expensive expectations",
      "the friend who received the same recycled e-card three years in a row",
    ),
    t(
      "The always-late friend",
      'The friend who texts "five minutes away" while still deciding what to wear',
      "the chronically late friend with fictional arrival times",
      "the friend who has spent half their life waiting outside",
    ),
  ],
  debate: [
    t(
      "Is ghosting ever justified?",
      "Ghosting is sometimes the right way to end a relationship",
      "argue FOR the proposition",
      "argue AGAINST the proposition",
    ),
    t(
      "Money beats chemistry?",
      "Financial stability matters more than chemistry when choosing a partner",
      "argue FOR the proposition",
      "argue AGAINST the proposition",
    ),
    t(
      "Influencers are overpaid",
      "Influencers are overpaid for the value they create",
      "argue FOR the proposition",
      "argue AGAINST the proposition",
    ),
    t(
      "Phone passwords in relationships",
      "Couples should share their phone passwords",
      "argue FOR the proposition",
      "argue AGAINST the proposition",
    ),
    t(
      "Destination wedding drama",
      "Asking friends to pay for your destination wedding is selfish",
      "argue FOR the proposition",
      "argue AGAINST the proposition",
    ),
    t(
      "Family is not a free pass",
      "You should cut off toxic relatives even if it divides the family",
      "argue FOR the proposition",
      "argue AGAINST the proposition",
    ),
    t(
      "Should the first date be split?",
      "The bill on a first date should always be split equally",
      "argue FOR the proposition",
      "argue AGAINST the proposition",
    ),
    t(
      "The hustle-culture trap",
      "Hustle culture sells burnout as ambition",
      "argue FOR the proposition",
      "argue AGAINST the proposition",
    ),
    t(
      "Would you take back a cheater?",
      "A relationship can become stronger after someone cheats",
      "argue FOR the proposition",
      "argue AGAINST the proposition",
    ),
    t(
      "Talent vs connections",
      "Connections matter more than talent when building a career",
      "argue FOR the proposition",
      "argue AGAINST the proposition",
    ),
    t(
      "Should kids owe their parents?",
      "Adult children do not owe their parents the life their parents planned",
      "argue FOR the proposition",
      "argue AGAINST the proposition",
    ),
    t(
      "Private life, public content",
      "Turning your relationship into content ruins the relationship",
      "argue FOR the proposition",
      "argue AGAINST the proposition",
    ),
  ],
  poetry: [
    t(
      "The apology that came too late",
      "An apology arrives on the day you finally stop needing it",
      "write from the person who waited and then moved on",
      "write from the person who finally found the words too late",
    ),
    t(
      "The wedding you were not invited to",
      "Watching the person you once loved marry someone else",
      "write from the person watching from a distance",
      "write from the person choosing a new life",
    ),
    t(
      "Home is no longer home",
      "Going back to your childhood home and feeling like a guest",
      "write from the returning child who has changed",
      "write from the parent who kept the room unchanged",
    ),
    t(
      "A voice note you cannot delete",
      "The last voice note from someone you cannot call anymore",
      "write from the person replaying the message",
      "write an imagined answer that adds a different emotional truth",
    ),
    t(
      "Famous online, lonely offline",
      "A million followers and nobody to call at midnight",
      "write from behind the public smile",
      "write from the ordinary friend watching the distance grow",
    ),
    t(
      "We were friends before the money",
      "Two best friends become strangers after one of them gets rich",
      "write from the friend who succeeded and feels misunderstood",
      "write from the friend who feels left behind",
    ),
    t(
      "The life you did not choose",
      "The life you chose meets the life you were too scared to try",
      "write as the life that chose safety",
      "write as the imagined life that took the risk",
    ),
    t(
      "Still paying for the dream",
      "Your parents are getting older while you keep chasing your dream",
      "write from the dreamer feeling time slip away",
      "write from the parent who never says how much they miss you",
    ),
    t(
      "The last ride home",
      "The last ride home with a friend before they leave the country",
      "write from the friend who is leaving",
      "write from the friend who has to stay",
    ),
    t(
      "Deleting the photos",
      "Deleting the photos is easy; forgetting the ordinary days is not",
      "write from the person trying to erase the past",
      "write from the ordinary memories that refuse to disappear",
    ),
    t(
      "The empty chair at dinner",
      "Nobody mentions the empty chair at the family dinner",
      "write from the person trying to keep dinner normal",
      "write from the person who finally breaks the silence",
    ),
    t(
      "The person you became to survive",
      "Meeting the younger self who would not recognize you now",
      "write from the adult explaining what survival cost",
      "write from the younger self refusing an easy excuse",
    ),
  ],
  story: [
    t(
      "The wedding group-chat leak",
      "Five minutes before the wedding, the family group chat receives a voice note nobody was meant to hear",
      "continue the same fictional story",
      "continue the same fictional story",
    ),
    t(
      "The lottery winner in hiding",
      "You win the lottery, tell nobody, and your best friend starts acting suspiciously generous",
      "continue the same fictional story",
      "continue the same fictional story",
    ),
    t(
      "The ex at the engagement party",
      "Your ex arrives at your engagement party carrying a gift and a secret",
      "continue the same fictional story",
      "continue the same fictional story",
    ),
    t(
      "The fake-rich weekend",
      "An influencer borrows a mansion for one video, then the real owner arrives during the livestream",
      "continue the same fictional story",
      "continue the same fictional story",
    ),
    t(
      "The inheritance dinner",
      "A family gathers to hear a will, and the person serving dinner inherits everything",
      "continue the same fictional story",
      "continue the same fictional story",
    ),
    t(
      "The wrong suitcase",
      "Two strangers swap suitcases at the airport; one contains cash, the other a wedding dress",
      "continue the same fictional story",
      "continue the same fictional story",
    ),
    t(
      "The roommate nobody remembers",
      "Your landlord asks why you live alone, but you have had the same roommate for three years",
      "continue the same fictional story",
      "continue the same fictional story",
    ),
    t(
      "The dinner reservation",
      "Someone has paid for your dinner every Friday for a year; tonight they finally take the opposite seat",
      "continue the same fictional story",
      "continue the same fictional story",
    ),
    t(
      "The final rent payment",
      "A landlord offers a struggling tenant one year of free rent for attending a single family dinner",
      "continue the same fictional story",
      "continue the same fictional story",
    ),
    t(
      "The reunion revenge",
      "At the school reunion, the person everyone bullied is the only one who knows why the doors are locked",
      "continue the same fictional story",
      "continue the same fictional story",
    ),
    t(
      "The accidental confession",
      "A birthday surprise goes wrong when the lights turn on before the wrong person finishes confessing",
      "continue the same fictional story",
      "continue the same fictional story",
    ),
    t(
      "The first-class stranger",
      "A stranger upgrades your flight to first class and asks you to pretend you have been married for ten years",
      "continue the same fictional story",
      "continue the same fictional story",
    ),
  ],
};

export function findTopic(mode, title) {
  return (
    TOPICS[mode]?.find(
      (t) =>
        t.title.toLocaleLowerCase() ===
        String(title).trim().toLocaleLowerCase(),
    ) ?? null
  );
}
