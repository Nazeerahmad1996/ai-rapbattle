# BotBrawl: Acid Circuit

## Direction

An underground robot MC fighting-game lobby. Original violet and acid-lime character artwork, ink-black backgrounds, condensed italic display type, graphic format cards, a central VS, and a persistent launch bar. The user's references inform hierarchy and composition; no borrowed game characters or stock artwork are used.

## Research applied

- [Riot: VALORANT interface redesign](https://playvalorant.com/en-us/news/game-updates/preview-the-future-of-valorant-s-interface/): character key art, expressive color, simplified shapes, mirrored team banners, strong CTA, and continuity from lobby to match results. Applied to two original robot MCs, stable player colors, HUD portraits and archive artwork.
- [Riot: User Interface Design](https://www.riotgames.com/it/artedu/user-interface-design): coherent visual and motion design across the game experience. Applied through shared type, surfaces, player colors and interactions across all screens.
- [Xbox: UI navigation](https://learn.microsoft.com/en-us/xbox/accessibility/xbox-accessibility-guidelines/112): predictable focus and consistent navigation. Applied with keyboard radio navigation, visible focus rings, semantic archive buttons, focus transfer to view headings, and accessible labels.
- [Xbox: contrast](https://learn.microsoft.com/en-us/xbox/accessibility/xbox-accessibility-guidelines/102): separate readable information from detailed artwork. Applied with near-opaque battle text panels and isolated RTL content.
- [Xbox: motion](https://learn.microsoft.com/en-us/xbox/accessibility/xbox-accessibility-guidelines/117) and [W3C: animation from interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions): disable decorative movement. Applied with CSS and JavaScript reduced-motion support, including an immediate finish when preference changes.
- [Chrome: animation performance](https://web.dev/articles/animations-guide): favor transform and opacity. Applied with finite Anime.js entrances, 65ms stagger, 580ms easeOutExpo reveals, subtle portrait hover, and score feedback. No scrolling hijack or continuous movement behind reading surfaces.

## Review changes

Independent frontend and visual reviewers identified asynchronous launch/vote races, focus continuity, small labels, mobile Broadcast access, CTA visibility and a crowded VS caption. The implementation was revised to address these. Installed tools are described as selected, rather than promising authenticated readiness.

## Assets

Generated with the built-in image-generation tool, then copied into `public/assets/`. Both source outputs are retained at their original generated-image paths. Requested alpha is preserved. The robot mark is original SVG geometry; mode symbols are project-native SVGs. Google Fonts supplies Barlow Condensed, Space Grotesk and multilingual fallbacks. Anime.js is vendored locally with its MIT license.

- `public/assets/robot-violet.png`: Player 1 key art and HUD portrait.
- `public/assets/robot-lime.png`: Player 2 key art and HUD portrait.
- `public/assets/mark.svg`: original robot identity and favicon.

### Final prompt: violet character

Use case: stylized-concept. Asset type: original game character key art for BotBrawl web UI. Create a spectacular premium 3D stylized robot MC character, waist up portrait, facing slightly right, one hand holding a futuristic handheld microphone at chest height. Original design, not based on existing characters. White ceramic and graphite armor, rich violet translucent shoulder armor, glowing acid lime eye visor, small streetwear details and black hood-like neck cowl, confident playful combat rapper personality. Beautiful sculpted hard surface shapes, polished high-end hero shooter game render with painterly graphic edges, strong silhouette. Violet rim light on left and acid lime rim light on right, clean subtle shadow. Composition character centered, helmet entirely visible with generous top margin, waist cropped at bottom, microphone visible. Pure transparent background. No letters, text, logos, watermark, typography, UI, floating particles, weapons. Portrait 2:3 aspect ratio.

### Final prompt: lime character

Use case: stylized-concept. Asset type: original game character key art for BotBrawl web UI. Create a spectacular premium 3D stylized robot MC character, waist up portrait facing slightly left, one armored hand holding a futuristic handheld microphone at chest height. Original design, not based on existing characters. Graphite and pale ivory armor, vivid acid lime yellow angular shoulder plates and over-ear headset, small glowing violet eyes behind dark faceplate, chest with circular violet speaker element, confident slightly mischievous robot battle rapper personality. Beautiful sculpted hard surface shapes, polished high-end hero shooter game render with painterly graphic edges, strong silhouette. Acid lime rim light on right and violet fill on left, clean subtle shadow. Composition character centered, helmet entirely visible with generous top margin, waist cropped at bottom, microphone visible. Pure transparent background. No letters, text, logos, watermark, typography, UI, floating particles, weapons. Portrait 2:3 aspect ratio.

## Validation

- `npm test`: 12 tests passed (8 battle-engine checks and 4 frontend regression checks).
- Browser checks: laptop and 390px phone layouts; format selection with arrow keys; mirror-match platform selection; optional judge controls; language and summary updates; semantic archive navigation; completed Urdu replay; result controls; phone Broadcast layout; focus clearance above the sticky launch dock.
- No horizontal page overflow in tested desktop and phone layouts. All referenced images loaded; both generated character images retain alpha. No browser warnings or errors were observed in the final check.
- Provider generation remains covered by the existing fake-adapter engine tests; no new provider call was made as part of this redesign verification.
- Previews: `docs/previews/lobby-desktop.jpg`, `lobby-mobile.jpg`, `battle-desktop.jpg`, `results-desktop.jpg`, and `archive-desktop.jpg`.
