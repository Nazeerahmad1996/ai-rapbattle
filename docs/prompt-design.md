# Topics and performance direction

## Audience

Relatable entertainment for viewers who have no coding background. Everyday rivalries are the hook: friendship, borrowed money, fake luxury, exes, wedding drama, hustle culture, family expectations and social media. Presets are fictional premises, not accusations about real people. There are 12 per format, 60 total, in `server/topics.js`.

## What changed

- Each preset defines a title and explicit A/B roles. Rap and roast contestants embody those characters; debate contestants keep opposite positions; poets get contrasting perspectives; story contestants continue one shared narrative.
- Provider names remain on the scoreboard, but are excluded from performer and judge identities. This removes a major source of version-number puns, coding jokes and model-superiority boasts.
- Each match samples two distinct voices once and keeps them stable. A shuffled deck provides different optional turn approaches for both sides, without reuse over the supported 1–5 rounds. These directions are internal and never announced in the performance.
- Rebuttals can appear anywhere; no mandatory opening template. Callbacks are encouraged when they add meaning; recycled premises, jokes, metaphors and rhyme endings are discouraged.
- Judge feedback is private craft coaching. Performers must not quote the judge or argue about scores. The judge receives previous rounds to recognize recycled material, while scoring only the current pair.
- Poetry is not forced into insults or escalating tragedy. Stories preserve established facts, follow consequences and resolve in the last passage rather than adding a twist at every turn. Debate avoids invented statistics and quotations.
- Language instructions favor natural local idiom over a literal English template. The existing clean-language checkbox is retained; neither that checkbox nor a prompt guarantees platform monetization or policy outcomes.

## Topic controls

The setup shows three clickable suggestions and a Surprise me button. Selection history is separate from displaying suggestions, so opening chips does not consume the shuffle cycle. Choices are remembered locally when storage is available. Custom topic text survives format changes. Selecting a preset or Surprise me deliberately replaces it. Reselecting the active format preserves the topic and response length.

## Contract and checks

`docs/modes.openapi.json` records the additive `topics` field on GET `/api/modes`. The battle creation request still accepts the same topic string. Exact preset titles resolve roles on the server; custom topics remain valid.

Local tests cover all 60 preset shapes, roles, provider-name exclusion, stable voices, unique turn directions, final story resolution, judge history, the actual shuffle-handler cycle, non-destructive mode selection, plus existing battle and frontend regressions. The live catalog check returned HTTP 200 with five modes and 60 valid presets. Browser checks confirmed twelve distinct roast selections before repetition, preservation of a custom topic across a format change, and phone layout without horizontal overflow.

The review agent identified that suggestion display must not consume the selected-topic cycle and that clicking the active format must preserve configuration. Both were fixed and regression-tested. Model output remains probabilistic; randomized directions reduce repeated scaffolding rather than guaranteeing every line will be unique.

## Live generation check

Two one-round English roast matches (three sentences per contestant, clean language, no judge) were generated with the installed Codex `gpt-6-luna` adapter on the same borrowed-money premise. All four turns kept the fictional borrower/lender roles and stayed away from coding or provider jokes. The first pair built on the delayed repayment and a screenshot as proof; the second introduced the unpaid debt as an adopted exhibit and developed that callback. These are qualitative samples, not a statistical uniqueness benchmark. The samples were neither saved as battles nor published. Final regression suite: 21 tests passed.
