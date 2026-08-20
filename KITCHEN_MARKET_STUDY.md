# Kitchen market study — Cooklist, MealBoard, KitchenPal, Grocy, Paprika

Read against the HomeHub Meals (M3) and Pantry (P5) handoffs and the seven gaps drawn in
`HomeHub Kitchen Explorations.dc.html`. Sources are the apps' own listings, docs and user reviews.

## 1. What all five do that HomeHub doesn't yet

**Generate the list from the plan, subtracting stock.** Cooklist adds only the missing
ingredients when you pick recipes; MealBoard generates the list from the meal-plan calendar and
respects pantry stock; Grocy has a whole-week "put missing products on shopping list" button.
This is table stakes, and it confirms gap 1 (`1a`/`1b`) as the single most important addition.

**Consolidate an ingredient across the week into one line.** Paprika and MealBoard both combine
duplicate ingredients into a single grocery item. `1a` already does this and goes further by
keeping the per-night breakdown visible — that's a genuine advantage, keep it.

**Aisle order the household controls.** Paprika lets you add custom aisles and rearrange them;
MealBoard lets you order aisles the way you actually walk the store, and supports assigning items
to different stores. `1g` groups by aisle but assumes a fixed order. Add: editable aisle order,
and optionally a store per item.

**Ticking in the shop puts things away.** MealBoard moves ticked items straight into the pantry so
nothing needs re-scanning at home. HomeHub already behaves this way, which makes `1h` a receipt
rather than a second commit. Correct as drawn.

**Recipe scaling that flows into the arithmetic.** Paprika scales to a target serving size and
converts units, including alternates like "1 cup (200 g)"; MealBoard scales and converts too.
HomeHub shows "cooking for 6" but the handoff doesn't expose scaling — and if servings change,
the list arithmetic must change with it. This is a missing primitive, not a screen.

**Reusable weeks.** Paprika saves meal plans as reusable Menus; MealBoard has templates. HomeHub's
week planner has no "save this week" — cheap to add, and it is what makes a planner survive
month three.

## 2. Where the market fails, and HomeHub should not follow

**Expiry dates are asserted far beyond what the data supports.** Cooklist and KitchenPal both push
expiry notifications and "use it up" suggestions. KitchenPal's own reviews report barcode lookups
finding roughly a third of products, wrong photos, and items that can't be found at all — which is
exactly the input those dates depend on. The `PANTRY_DATA_CONTRACT.md` ban on typed expiry dates
holds up. Recommendation stands: ship `1n` (opened-when, from events HomeHub already records),
keep `1m` (scanned dates only) behind good scan coverage.

**Manual pantries decay.** Reviewers describe Paprika's pantry as useful "if you're able to keep
up-to-date"; every app in the set relies on the household maintaining stock and none of them show
you how old a belief is. HomeHub's age column plus reconcile (`1i`/`1j`) is the strongest
differentiator in this whole study — no competitor treats stock as dated evidence.

**Feature sprawl reads as complexity.** KitchenPal's most common complaint is that the app feels
overwhelming and hard to navigate. Grocy is explicitly an "ERP beyond your fridge". HomeHub's
advantage is one wall panel with ten nav items; adding pantry sub-modes and dashboards would spend
that advantage.

## 3. Three ideas worth stealing outright

**Stock reservation across the plan (from Grocy's known weakness).** A long-standing Grocy issue
describes two planned recipes each believing they can consume the same single unit: the meal plan
makes no reservation, so the list and the "can I cook this" check both over-count. HomeHub's week
review (`1a`) is the natural place to reserve — Wednesday claims the cream, so Thursday's dal shows
as short rather than covered. No competitor in this set does this properly.

**A due score for recipes (from Grocy's Due Score, Cooklist's expiring-items suggestions).** Both
rank recipes by how well they use up food that is about to go. HomeHub can do the same thing
without expiry dates: rank by what's open and how long it's been open. That turns `1f` from
"what could I cook" into "what should I cook first", which is a much better answer.

**Cooking produces stock (from Grocy's "produces product").** Consuming a recipe in Grocy can add
a product back to stock. HomeHub already plans Leftovers nights on the calendar — so cooking should
create a leftovers item in the fridge with a date, and the leftovers night should consume it.
It closes the loop the planner currently only implies.

## 4. Ranked fine-tunings

1. Week plan → grocery review with reservation (`1a`, plus reservation logic).
2. Pack-size mapping stated in the direction users expect — "1 tin = 400 g", not a fractional
   unit conversion. Grocy users specifically ask for this direction (`1d`).
3. Recipe scaling as a first-class primitive that re-drives the list.
4. Due score from opened-when, feeding the folder and `1f`.
5. Editable aisle order, then store-per-item, for `1g`.
6. Leftovers as produced stock, tied to the Leftovers nights already in the planner.
7. Save-this-week as a template.
8. Receipt photo import to sit beside order import — Cooklist's loyalty-card route doesn't exist
   for a UK household, but a photographed receipt does the same job.

## 5. What not to build

Loyalty-card and retailer integrations (Cooklist's core, and its main lock-in), price tracking and
basket comparison, nutrition scores, and a recipe database of a million recipes. HomeHub owns
recipes the household chose; that is the point of the folder.
