You are the draft stage of the playable flow in this repository.

Card {{card.id}}: "{{card.title}}" for {{game.name}}.
The card, the Scene Spec, the game profile and the kit are in {{specFile}}. Read it first.

Make a real draft playable:
- Build on the existing core and template named in the spec: {{fields.core}}. If no core fits, stop and say so in notes; new mechanics go to the playable-mechanic path.
- Use only the kit assets listed in the spec file, exactly as they are. Never redraw, recolour or stretch a logo or end card.
- The win line is "{{fields.winLine}}". Never write "You Won". No em dashes in copy.
- Prize figure on screen: {{fields.prize}}. Use no other figure.
- Round length: {{fields.length}} seconds.
- Follow the repository's CLAUDE.md and the game's rules.

Save a portrait and a landscape screenshot of the draft into {{out}}, and put the draft's local path or link in draftUrl.
