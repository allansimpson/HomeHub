import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { ScreenShell, DrillInHeader, ScrollArea } from '../../components'
import { Icon } from '../../icons/Icon'
import { useMeals } from '../../app/MealsProvider'
import {
  GROUPING_THRESHOLD, cookedAgoLabel, cookedCountLabel, countWord, daysSinceCooked, lastCookedSentence,
  durationLabel, matchesAtWordBoundary, normaliseForSearch, panelAddress, planDate, todayKey,
} from '../../app/mealsDomain'
import { cuisineLabel, cuisineNameOf, plainTags, type FolderSort } from '../../app/mealsPrefs'
import type { MealSummaryDto, RecipeSummaryDto } from '../../api/types'
import { Chevron, HistoryColumn, MealsLabel, MealsSegment, RuleLine } from './parts'

/**
 * Recipe folder (MEALS_SCREEN §5–6, ids 6d flat / 4a grouped / 3b search / 1e empty).
 *
 * Browsing is primary and search is secondary, which is why the field is a hairline rather than a
 * filled bar: a household folder is dozens of recipes, not thousands, and scrolling one is faster
 * than typing at it.
 */
export function RecipeFolderScreen() {
  const navigate = useNavigate()
  const { recipes, meals, week, settings, updateSettings, loading } = useMeals()

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [cuisineFilter, setCuisineFilter] = useState<string | null>(null)
  /**
   * `ALL` · `MEALS` · `RECIPES` · `NEVER COOKED` (§4.4).
   *
   * **One list, one search, one sort.** Hunting in two places is exactly what this feature exists to
   * avoid, so these filter a single list rather than switching between two.
   */
  const [kind, setKind] = useState<'all' | 'meals' | 'recipes' | 'never'>('all')

  const live = recipes.filter((r) => !r.isArchived)
  const archivedCount = recipes.length - live.length
  const grouped = live.length >= GROUPING_THRESHOLD
  const sort = settings.folderSort

  // Which recipes are on the plate tonight — the folder's one live status, and the section's one
  // use of verdigris.
  const tonight = useMemo(() => {
    const today = todayKey()
    const ids = new Set<number>()
    for (const day of week?.days ?? []) {
      if (day.date !== today) continue
      for (const e of day.entries) if (e.slot === 'Dinner' && e.recipeId != null) ids.add(e.recipeId)
    }
    return ids
  }, [week])

  const liveMeals = meals.filter((m) => !m.isArchived)

  /**
   * Meals and recipes on one axis.
   *
   * §4.4 is explicit that this is one list with one search and one sort — a meal is a folder item,
   * not a separate category to go looking in. The `NOT LATELY` sort mixes both on the same axis,
   * which is the thing that makes a single list work at all.
   */
  const items = useMemo<FolderItem[]>(() => {
    const fromRecipes = live.map<FolderItem>((r) => ({
      key: `r${r.id}`,
      id: r.id,
      isMeal: false,
      title: r.title,
      cuisine: cuisineNameOf(r, settings.canonicalCuisines),
      lastCookedDate: r.lastCookedDate,
      timesCooked: r.timesCooked,
      lastSkippedDate: r.lastSkippedDate,
      // A variation's meta leads with YOUR VERSION where a recipe's leads with its source — words
      // rather than a badge, same principle as a meal naming its parts.
      meta: r.forkedFrom != null
        ? ['YOUR VERSION', r.totalMinutes != null ? durationLabel(r.totalMinutes).toUpperCase() : null]
            .filter(Boolean).join(' · ')
        : rowMeta(r, settings.canonicalCuisines),
      partial: r.completeness === 'Partial',
      route: `/meals/recipes/${r.id}`,
      forkedFrom: r.forkedFrom,
    }))
    const fromMeals = liveMeals.map<FolderItem>((m) => ({
      key: `m${m.id}`,
      id: m.id,
      isMeal: true,
      title: m.name,
      cuisine: cuisineLabel(m.cuisine, settings.canonicalCuisines),
      lastCookedDate: m.lastCookedDate,
      timesCooked: m.timesCooked,
      lastSkippedDate: null,
      meta: mealMeta(m),
      partial: false,
      route: `/meals/meals/${m.id}`,
      forkedFrom: null,
    }))
    return [...fromMeals, ...fromRecipes]
  }, [live, liveMeals, settings.canonicalCuisines])

  const filtered = useMemo(() => {
    let rows = items
    if (kind === 'meals') rows = rows.filter((i) => i.isMeal)
    else if (kind === 'recipes') rows = rows.filter((i) => !i.isMeal)
    else if (kind === 'never') rows = rows.filter((i) => i.lastCookedDate == null)
    if (cuisineFilter) rows = rows.filter((i) => i.cuisine === cuisineFilter)
    return nestVariations(sortItems(rows, sort))
  }, [items, kind, cuisineFilter, sort])

  const matches = useMemo(() => searchRecipes(live, query, settings.canonicalCuisines), [live, query, settings.canonicalCuisines])

  if (searching) {
    return (
      <SearchView
        query={query}
        setQuery={setQuery}
        matches={matches}
        canonical={settings.canonicalCuisines}
        onCancel={() => { setSearching(false); setQuery('') }}
        onOpen={(id) => navigate(`/meals/recipes/${id}`)}
      />
    )
  }

  // No `onBack`, deliberately. RECIPES is one of the three segment roots, not a drill-in: it is
  // reached by tapping RECIPES in the control directly below this header, and WEEK in that same
  // control is where a back arrow would have gone — so the arrow was both redundant and against
  // DrillInHeader's own rule that only drill-ins carry one.
  //
  // It was also the whole reason the section jumped when you changed segment. BackButton is 44px
  // tall against the header's 30px min-height, so the RECIPES header stood 14px taller than WEEK's
  // and PANTRY's and the tab strip moved under your finger. RECIPES being the *middle* segment is
  // why it felt like all three jumped: every adjacent switch involves it.
  const header = <DrillInHeader title="RECIPES" />

  // The state most households see first, and the one that teaches the path that actually works:
  // posting a link from a phone. The on-panel route is offered and honestly labelled SLOWER rather
  // than hidden, because sometimes it is the only one available.
  if (!loading && live.length === 0) {
    return (
      <ScreenShell header={header}>
        <MealsSegment active="recipes" />
        <EmptyFolder onAdd={() => navigate('/meals/recipes/new')} />
      </ScreenShell>
    )
  }

  const cuisines = countCuisines(live, settings.canonicalCuisines)

  return (
    <ScreenShell header={header}>
      <MealsSegment active="recipes" />
      <AttendantRow />

      <button type="button" className="ml-folder__search" onClick={() => setSearching(true)}>
        <Icon id="ico-search" size="1.25rem" />
        <span>Search by name, cuisine or tag</span>
      </button>

      <div className="ml-folder__sorts" role="tablist">
        {sortOptions(grouped).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={sort === key}
            className={'ml-folder__sort' + (sort === key ? ' ml-folder__sort--active' : '')}
            onClick={() => { updateSettings({ folderSort: key }); if (key !== 'cuisine') setCuisineFilter(null) }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Kind filters (§4.4) — above the sort segment, same chip styling as the cuisine row. Shown
          only once there is a meal to filter to; on a folder of only recipes they would be three
          chips that all say the same thing. */}
      {liveMeals.length > 0 && (
        <div className="ml-folder__chips">
          {([
            ['all', `ALL ${items.length}`],
            ['meals', `MEALS ${liveMeals.length}`],
            ['recipes', `RECIPES ${live.length}`],
            ['never', `NEVER COOKED ${items.filter((i) => i.lastCookedDate == null).length}`],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={'ml-folder__chip' + (kind === key ? ' ml-folder__chip--active' : '')}
              onClick={() => setKind(key)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {grouped && sort === 'cuisine' && (
        <div className="ml-folder__chips">
          <button
            type="button"
            className={'ml-folder__chip' + (cuisineFilter === null ? ' ml-folder__chip--active' : '')}
            onClick={() => setCuisineFilter(null)}
          >
            {`ALL ${items.length}`}
          </button>
          {cuisines.map(([name, count]) => (
            <button
              key={name}
              type="button"
              className={'ml-folder__chip' + (cuisineFilter === name ? ' ml-folder__chip--active' : '')}
              onClick={() => setCuisineFilter(name)}
            >
              {`${name.toUpperCase()} ${count}`}
            </button>
          ))}
        </div>
      )}

      <p className="ml-folder__caption">{captionFor(sort, items.length, grouped)}</p>
      <div className="ml-folder__grouprule" aria-hidden="true" />

      <ScrollArea>
        {filtered.length === 0 ? (
          <div className="ml-folder__nofilter">
            <p className="ml-folder__nofiltertitle serif">
              {cuisineFilter ? `No recipes in ${cuisineFilter}` : 'Nothing here yet'}
            </p>
            <button
              type="button"
              className="ml-folder__clearfilter"
              onClick={() => { setCuisineFilter(null); setKind('all') }}
            >
              CLEAR FILTER
            </button>
          </div>
        ) : (
          filtered.map((item) => (
            <FolderRow
              key={item.key}
              item={item}
              tonight={!item.isMeal && tonight.has(item.id)}
              onOpen={() => navigate(item.route)}
            />
          ))
        )}
      </ScrollArea>

      <div className="ml-folder__footer">
        <span className="ml-folder__count">
          {/* ITEMS, not RECIPES — the list holds both, and calling the total "recipes" would make
              the count disagree with what is on screen (§4.4). */}
          {`${items.length} ITEM${items.length === 1 ? '' : 'S'}`}
          {archivedCount > 0 && (
            <button type="button" className="ml-folder__archived" onClick={() => navigate('/meals/settings')}>
              {`ARCHIVED ${archivedCount} ▸`}
            </button>
          )}
        </span>
        {/* Two-way ADD (§4.4). A meal needs recipes to be made of, so it is only offered once there
            are at least two — before that the only honest choice is a recipe. */}
        <span className="ml-folder__addwrap">
          {live.length >= 2 && (
            <button type="button" className="ml-folder__addmeal" onClick={() => navigate('/meals/meals/new')}>
              ＋ MEAL
            </button>
          )}
          <button type="button" className="ml-folder__add" onClick={() => navigate('/meals/recipes/new')}>
            ＋ RECIPE
          </button>
        </span>
      </div>
    </ScreenShell>
  )
}

// ---- One list, meals and recipes together (MEALS_GROUPS §4.4) ----

/**
 * A folder row, whichever kind it is.
 *
 * Deliberately carries no "type" for the UI to badge with. What distinguishes a meal in the list is
 * that its meta line names its dishes where a recipe's names a source and a time — words rather
 * than chrome.
 */
interface FolderItem {
  key: string
  id: number
  isMeal: boolean
  title: string
  cuisine: string | null
  lastCookedDate: string | null
  timesCooked: number
  lastSkippedDate: string | null
  meta: string
  partial: boolean
  route: string
  /** Non-null on a variation — drives the indent and the YOUR VERSION meta lead. */
  forkedFrom: number | null
}

function sortItems(rows: FolderItem[], sort: FolderSort): FolderItem[] {
  const out = [...rows]
  switch (sort) {
    case 'az':
      return out.sort((a, b) => a.title.localeCompare(b.title))
    case 'cuisine':
    case 'tag':
      return out.sort((a, b) =>
        (a.cuisine ?? '￿').localeCompare(b.cuisine ?? '￿') || a.title.localeCompare(b.title))
    default:
      // Never-cooked first, on the same axis for both kinds — that is what makes one list work.
      return out.sort((a, b) => daysSince(b) - daysSince(a) || a.title.localeCompare(b.title))
  }
}

/**
 * Pull each variation up to sit immediately under its original, whatever the sort.
 *
 * **The parent takes the sort position** (MEALS_FORK §4.3) — a variation never sorts away from its
 * original, which is the whole point of the indent. A variation whose parent is filtered out or
 * deleted keeps its own place rather than vanishing.
 */
function nestVariations(rows: FolderItem[]): FolderItem[] {
  const byId = new Map(rows.filter((r) => !r.isMeal).map((r) => [r.id, r]))
  const children = new Map<number, FolderItem[]>()
  for (const row of rows) {
    if (row.forkedFrom == null || !byId.has(row.forkedFrom)) continue
    const list = children.get(row.forkedFrom)
    if (list) list.push(row)
    else children.set(row.forkedFrom, [row])
  }
  const out: FolderItem[] = []
  for (const row of rows) {
    // Skip a variation here; it is emitted under its parent below.
    if (row.forkedFrom != null && byId.has(row.forkedFrom)) continue
    out.push(row)
    // Only one level renders, even if the chain is deeper (§4.3).
    for (const child of children.get(row.id) ?? []) out.push(child)
  }
  return out
}

const daysSince = (item: FolderItem): number =>
  item.lastCookedDate == null
    ? Infinity
    : Math.floor((planDate(todayKey()).getTime() - planDate(item.lastCookedDate).getTime()) / 86_400_000)

/** `SPAGHETTI BOLOGNESE + GARLIC TOAST · 47 MIN` — a meal's parts, truncated past three. */
function mealMeta(meal: MealSummaryDto): string {
  const shown = meal.recipeTitles.slice(0, 3).map((t) => t.toUpperCase()).join(' + ')
  const parts = [meal.recipeTitles.length > 3 ? `${shown}…` : shown]
  if (meal.totalMinutes != null) parts.push(durationLabel(meal.totalMinutes).toUpperCase())
  return parts.join(' · ')
}

function FolderRow({
  item, tonight, onOpen,
}: {
  item: FolderItem
  tonight: boolean
  onOpen: () => void
}) {
  const history = tonight
    ? { value: 'TONIGHT', caption: 'PLANNED', live: true }
    : item.lastSkippedDate && (!item.lastCookedDate || item.lastSkippedDate > item.lastCookedDate)
      ? { value: 'SKIPPED', caption: shortSkipDate(item.lastSkippedDate), live: false }
      : {
          value: cookedAgoLabel(item.lastCookedDate),
          caption: item.lastCookedDate ? cookedCountLabel(item.timesCooked) : 'COOKED',
          live: false,
        }

  return (
    <button
      type="button"
      className={'ml-reciperow'
        + (tonight ? ' ml-reciperow--tonight' : '')
        + (item.forkedFrom != null ? ' ml-reciperow--variation' : '')}
      onClick={onOpen}
    >
      <span className="ml-reciperow__main">
        <span className={'ml-reciperow__title' + (item.partial ? ' ml-reciperow__title--partial' : '')}>
          {item.title}
        </span>
        <span className="ml-reciperow__meta">
          {item.meta}
          {item.partial && <span className="ml-reciperow__tag">NO STEPS</span>}
        </span>
      </span>
      <HistoryColumn value={history.value} caption={history.caption} live={history.live} />
      <Chevron />
    </button>
  )
}

/** `CUISINE · TIME · n INGREDIENTS`, each part dropped when its field is null. */
function rowMeta(recipe: RecipeSummaryDto, canonical: string[]): string {
  const parts: string[] = []
  const cuisine = cuisineNameOf(recipe, canonical)
  if (cuisine) parts.push(cuisine.toUpperCase())
  if (recipe.totalMinutes != null) parts.push(durationLabel(recipe.totalMinutes).toUpperCase())
  if (recipe.ingredientCount > 0) {
    parts.push(`${recipe.ingredientCount} INGREDIENT${recipe.ingredientCount === 1 ? '' : 'S'}`)
  }
  return parts.join(' · ')
}

function shortSkipDate(key: string): string {
  const [, m, d] = key.split('-')
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
  return `${Number(d)} ${months[Number(m) - 1]}`
}

// ---- Sorting and grouping ----

function sortOptions(grouped: boolean): [FolderSort, string][] {
  const base: [FolderSort, string][] = [['not-lately', 'NOT LATELY'], ['cuisine', 'CUISINE']]
  // The TAG axis only earns a cell once the folder is big enough for tags to be doing work.
  if (grouped) base.push(['tag', 'TAG'])
  base.push(['az', 'A — Z'])
  return base
}

/** Cuisines by recipe count, densest first — the chip row's order. */
function countCuisines(rows: RecipeSummaryDto[], canonical: string[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const name = cuisineNameOf(r, canonical)
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()].sort(([an, ac], [bn, bc]) => bc - ac || an.localeCompare(bn))
}

/**
 * The caption states the rule the list is currently obeying, so no order ever looks arbitrary —
 * and, below the threshold, says what would change if the folder grew.
 */
function captionFor(sort: FolderSort, count: number, grouped: boolean): string {
  if (!grouped) return `${countWord(count)} RECIPES · GROUPING STARTS AT ${countWord(GROUPING_THRESHOLD)}`
  switch (sort) {
    case 'az': return 'ALPHABETICAL'
    case 'cuisine': return 'GROUPED BY CUISINE · UNCATEGORISED LAST'
    case 'tag': return 'GROUPED BY TAG'
    default: return 'LONGEST SINCE COOKED FIRST · NEVER-COOKED AT THE TOP'
  }
}

// ---- Search (id 3b) ----

interface Match {
  recipe: RecipeSummaryDto
  /** Which field matched, so no result looks arbitrary. */
  via: 'name' | 'cuisine' | 'tag' | 'source'
  /** The matched tag or cuisine, for the chip. */
  viaText?: string
}

/**
 * Filters the already-loaded folder client-side — there is no search endpoint, and at household
 * scale there does not need to be (MEALS_DATA_CONTRACT §1).
 *
 * Ingredients are not searchable because the summary rows do not carry them. The screen says so
 * out loud rather than silently failing to find "chicken".
 */
function searchRecipes(rows: RecipeSummaryDto[], query: string, canonical: string[]): Match[] {
  const q = query.trim()
  if (!q) return []
  const out: Match[] = []
  for (const recipe of rows) {
    if (matchesAtWordBoundary(recipe.title, q)) { out.push({ recipe, via: 'name' }); continue }
    const cuisine = cuisineNameOf(recipe, canonical)
    if (cuisine && matchesAtWordBoundary(cuisine, q)) { out.push({ recipe, via: 'cuisine', viaText: cuisine }); continue }
    const tag = plainTags(recipe).find((t) => matchesAtWordBoundary(t, q))
    if (tag) { out.push({ recipe, via: 'tag', viaText: tag }); continue }
    if (recipe.sourceName && matchesAtWordBoundary(recipe.sourceName, q)) {
      out.push({ recipe, via: 'source', viaText: recipe.sourceName })
    }
  }
  // Name matches first — they are what people are usually looking for.
  const rank = { name: 0, cuisine: 1, tag: 2, source: 3 }
  return out.sort((a, b) => rank[a.via] - rank[b.via] || a.recipe.title.localeCompare(b.recipe.title))
}

function SearchView({
  query, setQuery, matches, canonical, onCancel, onOpen,
}: {
  query: string
  setQuery: (q: string) => void
  matches: Match[]
  canonical: string[]
  onCancel: () => void
  onOpen: (id: number) => void
}) {
  return (
    // No bottom nav: the keyboard is up, and a nav bar underneath it is a target nobody can reach.
    <div className="ml-shell">
      <div className="ml-shell__body ml-shell__body--noavatar">
        <div className="ml-folder__searchhead">
          <span className="ml-folder__searchfield">
            <Icon id="ico-search" size="1.25rem" />
            <input
              className="ml-folder__searchinput"
              value={query}
              autoFocus
              aria-label="Search recipes"
              placeholder="Search by name, cuisine or tag"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
            />
            {query && (
              <button type="button" className="ml-folder__clear" onClick={() => setQuery('')} aria-label="Clear search">
                ✕
              </button>
            )}
          </span>
          <button type="button" className="ml-folder__cancel" onClick={onCancel}>CANCEL</button>
        </div>
        <div className="ml-doublerule" aria-hidden="true">
          <div className="ml-doublerule__brass" />
          <div className="ml-doublerule__gap" />
          <div className="ml-doublerule__hair" />
        </div>

        <div className="ml-shell__content">
          <MealsLabel
            label={query ? `${matches.length} MATCH${matches.length === 1 ? '' : 'ES'}` : 'SEARCH'}
            status="NAME · CUISINE · TAG"
          />
          <ScrollArea>
            {query && matches.length === 0 ? (
              <div className="ml-folder__nofilter">
                <p className="ml-folder__nofiltertitle serif">{`Nothing matches ${query}`}</p>
                <button type="button" className="ml-folder__clearfilter" onClick={() => setQuery('')}>CLEAR</button>
              </div>
            ) : (
              matches.map(({ recipe, via, viaText }) => (
                <button key={recipe.id} type="button" className="ml-searchrow" onClick={() => onOpen(recipe.id)}>
                  <span className="ml-searchrow__main">
                    <span className="ml-searchrow__title">{highlight(recipe.title, query)}</span>
                    <span className="ml-searchrow__meta">
                      {rowMeta(recipe, canonical)}
                      {/* A hit in a tag rather than the name would otherwise look like a mistake,
                          so the row shows which word earned it. */}
                      {via !== 'name' && viaText && (
                        <span className="ml-searchrow__tag">
                          {`${via.toUpperCase()} `}
                          {highlight(viaText.toUpperCase(), query)}
                        </span>
                      )}
                    </span>
                  </span>
                  <Chevron />
                </button>
              ))
            )}
          </ScrollArea>
          <RuleLine>NAMES, CUISINES AND TAGS ONLY — INGREDIENTS AREN'T SEARCHABLE</RuleLine>
        </div>
      </div>
    </div>
  )
}

/** Brass the matched characters, so every result shows why it is a result. */
function highlight(text: string, query: string) {
  const q = query.trim()
  if (!q) return text
  const at = normaliseForSearch(text).indexOf(normaliseForSearch(q))
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <span className="ml-searchrow__hit">{text.slice(at, at + q.length)}</span>
      {text.slice(at + q.length)}
    </>
  )
}

// ---- First run (id 1e) ----

function EmptyFolder({ onAdd }: { onAdd: () => void }) {
  const address = panelAddress()
  return (
    <div className="ml-emptyfolder">
      <p className="ml-emptyfolder__title serif">The folder is empty.</p>
      <p className="ml-emptyfolder__body">
        {address
          ? 'Open the address below on your phone and add a recipe there — it appears here. Typing one in on the panel works too; it is just slower on a wall.'
          : 'Add a recipe on the panel below. Adding from a phone needs the panel served at its own address on the network.'}
      </p>

      {/* The QR is a placeholder, exactly as MEALS_SCREEN §5 specifies — a striped box reserving the
          space. It is not an encoded code and scanning it does nothing, so it is drawn only where
          the address beside it is real, and labelled as not-yet rather than left to be scanned in
          vain. The code itself lands with the M2 import endpoint it would point at. */}
      {address && (
        <div className="ml-emptyfolder__phone">
          <span className="ml-emptyfolder__qr" aria-hidden="true">
            <span className="ml-emptyfolder__qrlabel">QR TO COME</span>
          </span>
          <span className="ml-emptyfolder__phonemain">
            <span className="ml-emptyfolder__phonelabel">FROM YOUR PHONE</span>
            <span className="ml-emptyfolder__address">{`${address}/meals/recipes/new`}</span>
            <span className="ml-emptyfolder__phonenote">Same wi-fi. No app, no account. Type the address for now.</span>
          </span>
        </div>
      )}

      <button type="button" className="ml-emptyfolder__add" onClick={onAdd}>
        <span className="ml-emptyfolder__plus" aria-hidden="true">＋</span>
        <span className="ml-emptyfolder__addtext">Add one here instead</span>
        <span className="ml-emptyfolder__slower">SLOWER</span>
      </button>

      <RuleLine>NIGHTS STILL PLAN WITHOUT RECIPES — LEFTOVERS, TAKEOUT, ANYTHING TYPED</RuleLine>
    </div>
  )
}

// ---- The Attendant's one suggestion ----

/**
 * At most one suggestion, dismissible, never two rows (MEALS_SCREEN §5.2).
 *
 * Deliberately quiet: it offers the longest-uncooked recipe that would fit a free night, and if
 * there is no such recipe it says nothing at all rather than manufacturing advice.
 */
function AttendantRow() {
  const { recipes, week, settings, updateSettings } = useMeals()
  const [dismissed, setDismissed] = useState(false)
  const navigate = useNavigate()

  const suggestion = useMemo(() => {
    if (!settings.suggestUncooked || dismissed) return null
    const free = week?.days.some((d) => d.date >= todayKey() && !d.entries.some((e) => e.slot === 'Dinner'))
    if (!free) return null
    const candidates = recipes
      .filter((r) => !r.isArchived && r.completeness === 'Complete' && r.id !== settings.dismissedSuggestionId)
      .sort((a, b) => daysSinceCooked(b) - daysSinceCooked(a))
    return candidates[0] ?? null
  }, [recipes, week, settings, dismissed])

  if (!suggestion) return null
  const never = suggestion.lastCookedDate == null

  return (
    <div className="ml-attendantrow">
      <span className="ml-attendantrow__frame" aria-hidden="true"><span className="ml-attendantrow__mark" /></span>
      <span className="ml-attendantrow__main">
        <span className="ml-attendantrow__text">
          {never
            ? `${suggestion.title} has never been cooked. There's a free night this week.`
            : `${suggestion.title}: ${lastCookedSentence(suggestion.lastCookedDate).toLowerCase()}`}
        </span>
        <span className="ml-attendantrow__by">THE ATTENDANT</span>
      </span>
      <button type="button" className="ml-attendantrow__action" onClick={() => navigate(`/meals/recipes/${suggestion.id}`)}>
        LOOK
      </button>
      <button
        type="button"
        className="ml-attendantrow__dismiss"
        aria-label="Dismiss suggestion"
        onClick={() => { setDismissed(true); updateSettings({ dismissedSuggestionId: suggestion.id }) }}
      >
        ✕
      </button>
    </div>
  )
}
