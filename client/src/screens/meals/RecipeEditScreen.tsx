import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { ScrollArea, Stepper } from '../../components'
import { Icon } from '../../icons/Icon'
import { api, ApiError } from '../../api/client'
import { useSession } from '../../app/SessionProvider'
import { useMeals } from '../../app/MealsProvider'
import { agoLabel } from '../../app/mealsDomain'
// Canonical units are a Pantry idea the recipe folder shares, exactly as on the server: the stock
// check joins a recipe's units to the pantry's, so both sides have to spell "oz" the same way.
import { useUnits } from '../../app/units'
import type { RecipeDto, RecipeIngredientInput } from '../../api/types'
import { AmountKeypad, MealsLabel, MealsModal, RuleLine } from './parts'

/** One editable ingredient line: the amount and unit are fields; the tail is the source's words. */
interface Draft {
  id: number
  amount: string
  unit: string
  /** The descriptive remainder of the original line, kept verbatim. */
  tail: string
  sectionHeading: string | null
}

/**
 * Edit a recipe (MEALS_SCREEN §8, ids 2d form / 4e conflict).
 *
 * Deliberately narrow: the name, the amounts and units, and the base servings those amounts refer
 * to. The descriptive tail of each line is shown but not editable here, because it is the source's
 * wording and the thing this form exists to fix is "the recipe says 4 and we always cook 6".
 *
 * **The name is editable because nothing else could rename a recipe.** An importer's title is the
 * publisher's headline, a paste takes whatever line sat above the ingredients, and both are wrong
 * often enough that a folder full of them stops being browsable. There is no separate rename screen
 * and there should not be — renaming is an edit, and this is where edits happen.
 */
export function RecipeEditScreen() {
  const navigate = useNavigate()
  const { id } = useParams()
  const [params] = useSearchParams()
  const { activeProfileId } = useSession()
  const { refresh } = useMeals()

  const recipeId = Number(id)
  const [recipe, setRecipe] = useState<RecipeDto | null>(null)
  /** The name as edited. Blank is not savable — the server requires a title and so does the folder. */
  const [title, setTitle] = useState('')
  const [lines, setLines] = useState<Draft[]>([])
  const [servings, setServings] = useState<number | null>(null)
  const [focused, setFocused] = useState<number | null>(null)
  /** The line whose unit strip is open, if any. One at a time — it is a choice, not a mode. */
  const [picking, setPicking] = useState<number | null>(null)
  const units = useUnits()
  const [saving, setSaving] = useState(false)
  /** The server's version, when a save 409'd. Non-null puts the screen in its conflict state. */
  const [theirs, setTheirs] = useState<RecipeDto | null>(null)
  /** The two-way SAVE sheet, then the naming sheet. */
  const [choosing, setChoosing] = useState(false)
  const [forkName, setForkName] = useState<string | null>(null)
  const [keepLink, setKeepLink] = useState(true)

  /**
   * Has anything actually changed? The fork choice only appears when there is something to fork —
   * offering it on an untouched form would be asking a question with no content.
   */
  const dirty = useMemo(() => {
    if (!recipe) return false
    if (title.trim() !== recipe.title) return true
    if (servings !== recipe.servings) return true
    const original = recipe.ingredients.map(toDraft)
    if (original.length !== lines.length) return true
    return lines.some((l, i) => l.amount !== original[i]?.amount || l.unit !== original[i]?.unit)
  }, [recipe, title, lines, servings])

  /** The lines whose amounts differ, for WHAT YOU CHANGED. */
  const changed = useMemo(() => {
    if (!recipe) return []
    const original = new Map(recipe.ingredients.map((i) => [i.id, toDraft(i)]))
    return lines
      .map((l) => ({ line: l, was: original.get(l.id) }))
      .filter(({ line, was }) => was && (was.amount !== line.amount || was.unit !== line.unit))
      .map(({ line, was }) => ({
        name: line.tail || was!.tail,
        from: `${was!.amount} ${was!.unit}`.trim() || '—',
        to: `${line.amount} ${line.unit}`.trim() || '—',
      }))
  }, [recipe, lines])

  const readOnlyDiff = params.get('diff') === '1'

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next = await api.getRecipe(recipeId)
      if (cancelled) return
      setRecipe(next)
      setTitle(next.title)
      setServings(next.servings)
      setLines(next.ingredients.map(toDraft))
    })()
    return () => { cancelled = true }
  }, [recipeId])

  const setAmount = useCallback((lineId: number, amount: string) => {
    setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, amount } : l)))
    setTheirs(null) // editing again clears a resolved conflict's inert state
  }, [])

  const setUnitOn = useCallback((lineId: number, unit: string) => {
    setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, unit } : l)))
    setTheirs(null)
  }, [])

  const close = () => navigate(-1)

  const save = useCallback(async () => {
    if (!recipe || !title.trim()) return
    setSaving(true)
    try {
      await api.updateRecipe(recipeId, buildInput(recipe, title, lines, servings, activeProfileId), recipe.version)
      await refresh()
      close()
    } catch (err) {
      // 409 means someone else got there first. Nothing is saved and nothing is discarded — the
      // form stays open with both versions on screen (MEALS_BEHAVIOURS §2).
      if (err instanceof ApiError && err.status === 409 && err.body) {
        setTheirs(err.body as RecipeDto)
      } else if (!(err instanceof ApiError)) {
        throw err
      }
    } finally {
      setSaving(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe, recipeId, title, lines, servings, activeProfileId, refresh])

  /**
   * The name to open the fork sheet with.
   *
   * A rename typed into the form above is already the name this version was meant to have, so it
   * seeds the sheet verbatim. Untouched, it falls back to the parent's name plus a suffix — two
   * recipes called "Chicken Piccata" is a folder nobody can read.
   */
  const forkSeed = () => {
    const typed = title.trim()
    return typed && recipe && typed !== recipe.title ? typed : `${recipe?.title ?? ''} — our version`
  }

  /**
   * Save the edit as a new recipe. The original is not written to at all — not even a version bump,
   * which is what makes §6's "byte-identical" criterion true rather than merely nearly true.
   */
  const fork = useCallback(async () => {
    if (!recipe || forkName === null) return
    setSaving(true)
    try {
      const created = await api.forkRecipe(recipe.id, {
        name: forkName.trim(),
        ingredients: lines
          .filter((l) => l.amount.trim() || l.unit.trim() || l.tail.trim())
          .map((l) => ({
            rawText: [l.amount.trim(), l.unit.trim(), l.tail.trim()].filter(Boolean).join(' '),
            quantity: parseAmount(l.amount),
            unit: l.unit.trim() || null,
            sectionHeading: l.sectionHeading,
          })),
        servings,
        keepLink,
        modifiedByProfileId: activeProfileId,
      })
      await refresh()
      navigate(`/meals/recipes/${created.id}`, { replace: true })
    } finally {
      setSaving(false)
    }
  }, [recipe, forkName, lines, servings, keepLink, activeProfileId, refresh, navigate])

  /** Re-save my values over theirs, against the version they left behind. */
  const keepMine = async () => {
    if (!recipe || !theirs || !title.trim()) return
    await api.updateRecipe(recipeId, buildInput(recipe, title, lines, servings, activeProfileId), theirs.version)
    await refresh()
    close()
  }

  /**
   * Take their value for the lines that differ and keep mine everywhere else. Not a wholesale
   * discard: the point of showing a per-line diff is that only some of the lines are contested.
   */
  const useTheirs = () => {
    if (!theirs || !recipe) return
    const byId = new Map(theirs.ingredients.map((i) => [i.id, toDraft(i)]))
    setLines((prev) => prev.map((mine) => byId.get(mine.id) ?? mine))
    // The name follows the same rule as the lines: theirs is taken only where I did not type over
    // it. A rename I made is an edit like any other and USE THEIRS does not discard those.
    setTitle((mine) => (mine.trim() === recipe.title ? theirs.title : mine))
    setRecipe(theirs)
    setServings(theirs.servings)
    setTheirs(null)
  }

  const differing = useMemo(() => (theirs ? diffLines(lines, theirs) : []), [lines, theirs])

  /**
   * Did the other device rename it?
   *
   * Called out separately because the per-line diff below cannot show it, and because KEEP MINE
   * would otherwise write my name over their rename with nothing on screen having mentioned it —
   * the one silent overwrite the conflict screen exists to prevent.
   */
  const renamedElsewhere = theirs != null && recipe != null && theirs.title !== recipe.title

  if (!recipe) {
    return <MealsModal title="RECIPE" onCancel={close}><div className="ml-recipe__skeleton" /></MealsModal>
  }

  // Opened from the attribution strip's SEE WHAT: read-only, and honest about what it can show.
  if (readOnlyDiff) {
    return (
      <MealsModal
        title={recipe.title}
        onCancel={close}
        cancelLabel="CLOSE"
      >
        <ScrollArea>
          <div className="ml-edit__notice">
            <Icon id="ico-person" size="1.1875rem" />
            <span>
              {`${recipe.modifiedByName ?? 'Someone'} changed the amounts`}
              {recipe.modifiedAtUtc ? ` ${agoLabel(recipe.modifiedAtUtc).toLowerCase()}` : ''}.
            </span>
          </div>
          <MealsLabel label="THE AMOUNTS NOW" status={`${lines.length} LINES`} />
          <div className="ml-edit__lines">
            {lines.map((line) => (
              <div className="ml-edit__row" key={line.id}>
                <span className="ml-edit__amountro mono">{line.amount || '—'}</span>
                <span className="ml-edit__unit">{line.unit || '—'}</span>
                <span className="ml-edit__tail">{line.tail}</span>
              </div>
            ))}
          </div>
          {/* Said plainly rather than mocked up: the panel keeps who changed a recipe last, not a
              per-line history, so there is no "before" to line these up against. The one place a
              true line-by-line diff exists is a save conflict, where both versions are in hand. */}
          <RuleLine>
            THE PANEL KEEPS WHO CHANGED THIS LAST, NOT A HISTORY OF EVERY CHANGE
          </RuleLine>
        </ScrollArea>
      </MealsModal>
    )
  }

  return (
    <MealsModal
      title="EDIT RECIPE"
      onCancel={close}
      confirm={
        <button
          type="button"
          className={'ml-edit__save' + (theirs ? ' ml-edit__save--inert' : '')}
          // A blank name is refused here rather than by the server: the PUT would 400 after every
          // amount had already been typed, which is the worst possible moment to find out.
          disabled={theirs != null || saving || !title.trim()}
          // Once anything has changed, SAVE becomes a two-way choice (MEALS_FORK §1). The intent to
          // fork forms *while* you are typing, not as a "duplicate" you had to think of in advance —
          // so the affordance belongs at the moment of saving, and nowhere earlier.
          onClick={() => (dirty ? setChoosing(true) : void save())}
        >
          SAVE
        </button>
      }
      footer={focused != null ? (
        <AmountKeypad
          onKey={(ch) => setAmount(focused, appendAmount(lines.find((l) => l.id === focused)?.amount ?? '', ch))}
          onBackspace={() => setAmount(focused, (lines.find((l) => l.id === focused)?.amount ?? '').slice(0, -1))}
          onDone={() => setFocused(null)}
        />
      ) : undefined}
    >
      <ScrollArea>
        {theirs && (
          <div className="ml-edit__conflict">
            <div className="ml-edit__conflictmsg">
              <Icon id="ico-warning" size="1.25rem" />
              <span className="ml-edit__conflicttitle">CHANGED ON ANOTHER DEVICE</span>
              <span className="ml-edit__conflicttext">
                {`${theirs.modifiedByName ?? 'Someone'} edited this recipe `}
                {theirs.modifiedAtUtc ? agoLabel(theirs.modifiedAtUtc).toLowerCase() : 'just now'}
                , while you were typing.
              </span>
            </div>
            <div className="ml-edit__conflictactions">
              <button type="button" className="ml-edit__keepmine" onClick={() => void keepMine()}>KEEP MINE</button>
              <button type="button" className="ml-edit__usetheirs" onClick={useTheirs}>USE THEIRS</button>
            </div>
            {/* The third, quieter option (MEALS_FORK §1). Nobody loses work, both intentions
                survive, and the household stops arguing through the recipe. */}
            <button
              type="button"
              className="ml-edit__forkinstead"
              onClick={() => setForkName(forkSeed())}
            >
              SAVE MINE AS MY OWN VERSION
            </button>
          </div>
        )}

        {theirs && (
          <>
            {/* Above the lines and under its own heading, not folded into the LINES count — a
                rename is not a line, and burying it in a list of amounts is how it would get
                agreed to by accident. */}
            {renamedElsewhere && (
              <>
                <MealsLabel label="THE NAME DIFFERS" />
                <div className="ml-edit__diff">
                  <span className="ml-edit__diffname">What it is called</span>
                  <div className="ml-edit__diffcells">
                    <span className="ml-edit__yours">
                      <span className="ml-edit__difflabel">YOURS</span>
                      <span className="ml-edit__diffvalue">{title.trim() || '—'}</span>
                    </span>
                    <span className="ml-edit__theirs">
                      <span className="ml-edit__difflabel">THEIRS</span>
                      <span className="ml-edit__diffvalue">{theirs.title}</span>
                    </span>
                  </div>
                </div>
              </>
            )}
            <MealsLabel label="WHAT DIFFERS" status={`${differing.length} LINE${differing.length === 1 ? '' : 'S'}`} />
            {differing.map(({ mine, their }) => (
              <div className="ml-edit__diff" key={mine.id}>
                <span className="ml-edit__diffname">{mine.tail || their.tail}</span>
                <div className="ml-edit__diffcells">
                  <span className="ml-edit__yours">
                    <span className="ml-edit__difflabel">YOURS</span>
                    <span className="ml-edit__diffvalue mono">{`${mine.amount} ${mine.unit}`.trim() || '—'}</span>
                  </span>
                  <span className="ml-edit__theirs">
                    <span className="ml-edit__difflabel">THEIRS</span>
                    <span className="ml-edit__diffvalue mono">{`${their.amount} ${their.unit}`.trim() || '—'}</span>
                  </span>
                </div>
              </div>
            ))}
            <p className="ml-edit__diffwhy">
              KEEP MINE writes your version over theirs, the name included. USE THEIRS takes their
              value for anything above you did not type over yourself, and leaves every other edit
              you made alone.
            </p>
            <RuleLine>
              NOTHING IS SAVED UNTIL YOU CHOOSE · THE FORM STAYS OPEN OFFLINE AND REPLAYS ON RECONNECT
            </RuleLine>
          </>
        )}

        <div className="ml-edit__notice">
          <Icon id="ico-person" size="1.1875rem" />
          <span>Your copy. Edits stay on the panel and the source link is kept for reference.</span>
        </div>

        {/*
          The name, first, because it is the thing the folder is read by.

          An importer hands back the publisher's headline and a paste takes whatever line sat above
          the ingredients — both are right often enough to be worth keeping and wrong often enough
          that there has to be a way to fix them.

          A rename reaches everything that joins to the recipe — the folder and every night on the
          week plan read `Recipe.Title` live — but **not** a shopping list already built, because a
          grocery line stores the title it was added under rather than a link to it. That is the
          right call there (a list should still say where a line came from after the recipe is
          deleted) and it is the one surprise in a rename, so the rule line below says so.

          Empty is refused at SAVE rather than snapped back while typing — clearing the box on the
          way to typing a new name is what everybody does first. The label says REQUIRED while it is
          blank and the box is left alone; amber here would be an alert, and this is not one.
        */}
        <MealsLabel label="NAME" status={title.trim() ? undefined : 'REQUIRED'} />
        <input
          className="ml-edit__name"
          value={title}
          maxLength={300}
          aria-label="Recipe name"
          placeholder="What the household calls it"
          onChange={(e) => { setTitle(e.target.value); setTheirs(null) }}
        />
        {/* Both halves are worth the line: the reach nobody expects, and the one place it stops. */}
        <RuleLine>THE FOLDER AND THE WEEK FOLLOW A RENAME · SHOPPING LIST LINES KEEP THE OLD NAME</RuleLine>

        <div className="ml-edit__base">
          <span className="ml-edit__basemain">
            <span className="ml-edit__baselabel">BASE SERVINGS</span>
            <span className="ml-edit__basenote">WHAT THE AMOUNTS BELOW MAKE</span>
          </span>
          <span className="ml-edit__stepper">
            <Stepper direction="minus" onStep={() => setServings((s) => Math.max(1, (s ?? 1) - 1))} label="Fewer base servings" />
            <span className="ml-edit__basevalue serif">{servings ?? '—'}</span>
            <Stepper direction="plus" onStep={() => setServings((s) => Math.min(50, (s ?? 0) + 1))} label="More base servings" />
          </span>
        </div>

        <div className="ml-edit__lines">
          {lines.map((line, i) => {
            const heading = line.sectionHeading && line.sectionHeading !== lines[i - 1]?.sectionHeading
            return (
              <div key={line.id}>
                {heading && <div className="ml-edit__subhead">{line.sectionHeading!.toUpperCase()}</div>}
                <div className="ml-edit__row">
                  <input
                    // data-no-osk keeps the global letter keyboard away: this field takes digits and
                    // fractions, and the pad at the foot of the screen is the one that offers them.
                    data-no-osk
                    className={
                      'ml-edit__amount mono' +
                      (focused === line.id ? ' ml-edit__amount--focus' : '') +
                      (line.amount ? '' : ' ml-edit__amount--unset')
                    }
                    value={line.amount}
                    placeholder="SET"
                    aria-label={`Amount for ${line.tail}`}
                    readOnly
                    onFocus={() => setFocused(line.id)}
                    onClick={() => setFocused(line.id)}
                  />
                  <button
                    type="button"
                    className={'ml-edit__unit' + (picking === line.id ? ' ml-edit__unit--on' : '')}
                    aria-expanded={picking === line.id}
                    aria-label={`Unit for ${line.tail}`}
                    onClick={() => setPicking((at) => (at === line.id ? null : line.id))}
                  >
                    {/* Verbatim now that units have one stored spelling: upper-casing it would show
                        `ML` for the `mL` actually saved, on the one control whose job is to say
                        which spelling that is. */}
                    {line.unit || '—'}
                  </button>
                  <span className="ml-edit__tail">{line.tail}</span>
                </div>
                {/*
                  The units, from the server's own list rather than a constant kept here — which is
                  the point of the lookup table: a household that types "sleeve" into the pantry is
                  offered it on a recipe line too, and this screen can never drift into offering a
                  spelling the database no longer stores.

                  Tapped open rather than cycled through. Cycling was fine for thirteen hard-coded
                  units and is unusable for a list that grows; and it is a keyboard-free control
                  either way, which this row needs — the amount beside it drives its own keypad, and
                  a text box here would summon a second one on top of it.
                */}
                {picking === line.id && (
                  <div className="ml-edit__units" role="listbox" aria-label="Unit">
                    <button
                      type="button"
                      role="option"
                      aria-selected={line.unit === ''}
                      className={'ml-edit__unitchip' + (line.unit === '' ? ' ml-edit__unitchip--on' : '')}
                      onClick={() => { setUnitOn(line.id, ''); setPicking(null) }}
                    >
                      —
                    </button>
                    {units.map((unit) => (
                      <button
                        type="button"
                        key={unit.canonical}
                        role="option"
                        aria-selected={unit.canonical === line.unit}
                        aria-label={unit.displayName ?? unit.canonical}
                        className={
                          'ml-edit__unitchip' + (unit.canonical === line.unit ? ' ml-edit__unitchip--on' : '')
                        }
                        onClick={() => { setUnitOn(line.id, unit.canonical); setPicking(null) }}
                      >
                        {unit.canonical}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </ScrollArea>

      {/* Outside the scroll area: adding a line is an action on the list, not the last item in it. */}
      <button
        type="button"
        className="ml-edit__addline"
        onClick={() => setLines((prev) => [...prev, { id: -Date.now(), amount: '', unit: '', tail: '', sectionHeading: null }])}
      >
        ＋ Add a line
      </button>
      <RuleLine>SETTING AN AMOUNT ALSO MAKES THAT LINE SCALE WITH SERVINGS</RuleLine>

      {/* The two-way SAVE. Both options are live and neither is styled as the "safe" one — saving
          over the recipe and saving your own version are equally legitimate intentions. */}
      {choosing && forkName === null && (
        <div className="ml-forkchoice">
          <span className="ml-forkchoice__label">SAVE WHERE</span>
          <button
            type="button"
            className="ml-forkchoice__opt"
            onClick={() => { setChoosing(false); void save() }}
          >
            <span className="ml-forkchoice__opttitle">Save to this recipe</span>
            <span className="ml-forkchoice__optsub">{`${recipe.title} changes for everyone`}</span>
          </button>
          <button
            type="button"
            className="ml-forkchoice__opt ml-forkchoice__opt--fork"
            onClick={() => setForkName(forkSeed())}
          >
            <span className="ml-forkchoice__opttitle">Save as your own version</span>
            <span className="ml-forkchoice__optsub">{`${recipe.title} is left exactly as it was`}</span>
          </button>
          <button type="button" className="ml-forkchoice__cancel" onClick={() => setChoosing(false)}>
            KEEP EDITING
          </button>
        </div>
      )}

      {forkName !== null && (
        <ForkSheet
          name={forkName}
          setName={setForkName}
          parentTitle={recipe.title}
          changed={changed}
          keepLink={keepLink}
          setKeepLink={setKeepLink}
          duplicate={false}
          onCancel={() => { setForkName(null); setChoosing(false) }}
          onSave={() => void fork()}
          saving={saving}
        />
      )}
    </MealsModal>
  )
}

/**
 * The naming sheet (MEALS_FORK §4.1, id 8a).
 *
 * Naming is the only real friction in forking, so the sheet does the work: a prefilled name, three
 * one-tap suffixes, and — the part that earns its space — a plain statement of what is about to
 * come with the copy and what is not.
 */
function ForkSheet({
  name, setName, parentTitle, changed, keepLink, setKeepLink, duplicate, onCancel, onSave, saving,
}: {
  name: string
  setName: (n: string) => void
  parentTitle: string
  changed: { name: string; from: string; to: string }[]
  keepLink: boolean
  setKeepLink: (v: boolean) => void
  duplicate: boolean
  onCancel: () => void
  onSave: () => void
  saving: boolean
}) {
  const SUFFIXES = ['our version', 'double batch', 'weeknight']
  const base = parentTitle

  return (
    <MealsModal
      title="YOUR VERSION"
      onCancel={onCancel}
      cancelLabel="BACK"
      confirm={
        <button type="button" className="ml-edit__save" disabled={!name.trim() || saving} onClick={onSave}>
          SAVE
        </button>
      }
    >
      <ScrollArea>
        <MealsLabel label="NAME" />
        <input
          className="ml-fork__name"
          value={name}
          autoFocus
          maxLength={120}
          aria-label="Name for your version"
          onChange={(e) => setName(e.target.value)}
        />
        {/* Warn, never block (§3) — two recipes may legitimately share a name. */}
        {duplicate && <RuleLine>ANOTHER RECIPE ALREADY HAS THIS NAME</RuleLine>}

        <div className="ml-fork__chips">
          {SUFFIXES.map((s) => (
            <button
              key={s}
              type="button"
              className={'ml-fork__chip' + (name === `${base} — ${s}` ? ' ml-fork__chip--active' : '')}
              onClick={() => setName(`${base} — ${s}`)}
            >
              {s.toUpperCase()}
            </button>
          ))}
        </div>
        <RuleLine>TAP A SUFFIX OR TYPE YOUR OWN</RuleLine>

        {changed.length > 0 && (
          <>
            <MealsLabel label="WHAT YOU CHANGED" status={`${changed.length} LINE${changed.length === 1 ? '' : 'S'}`} />
            <div className="ml-fork__diff">
              {changed.map((c, i) => (
                <div className="ml-fork__diffrow" key={i}>
                  <span className="ml-fork__diffname">{c.name}</span>
                  <span className="ml-fork__was mono">{c.from}</span>
                  <span className="ml-fork__arrow">→</span>
                  <span className="ml-fork__now mono">{c.to}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="ml-fork__comes">
          <span className="ml-fork__comeslabel">WHAT COMES WITH IT</span>
          <p className="ml-fork__comestext">
            {`The steps, the source, the cuisine and every tag come across. How often ${parentTitle} `
              + 'has been cooked does not — this version starts at never cooked, because nobody has '
              + 'cooked it yet.'}
          </p>
          <button
            type="button"
            className="ml-fork__remember"
            aria-pressed={keepLink}
            onClick={() => setKeepLink(!keepLink)}
          >
            <span className={'ml-assign__check' + (keepLink ? ' ml-assign__check--on' : '')} aria-hidden="true">
              {keepLink && <Icon id="ico-check" size="0.875rem" />}
            </span>
            <span>{`Remember it came from ${parentTitle}`}</span>
          </button>
        </div>

        {/* The reassurance line. The one thing someone forking is actually worried about. */}
        <p className="ml-fork__safe">
          {`${parentTitle} is left exactly as it was. Nothing you typed touches it.`}
        </p>
      </ScrollArea>
    </MealsModal>
  )
}

// ---- rawText round-trip ----

/** The leading amount of a line, matching what `mealsDomain.scaleLine` substitutes. */
const LEADING_AMOUNT = /^\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d+\s*[¼½¾⅓⅔⅛⅜⅝⅞]|[¼½¾⅓⅔⅛⅜⅝⅞]|\d+(?:[.,]\d+)?)\s*/

/**
 * Split a stored line into the three editable parts.
 *
 * The tail is taken by removing the amount and unit **from the front of `rawText`**, not by
 * composing it from `name` + `note`. The parsed fields are best-effort; the raw line is what the
 * source actually wrote, and it is the only thing the panel is allowed to display
 * (MEALS_DATA_CONTRACT §1).
 */
function toDraft(line: {
  id: number; rawText: string; quantity: number | null; unit: string | null; sectionHeading: string | null
}): Draft {
  let rest = line.rawText
  const amountMatch = LEADING_AMOUNT.exec(rest)
  const amount = amountMatch ? amountMatch[1] : ''
  if (amountMatch) rest = rest.slice(amountMatch[0].length)

  const unit = line.unit ?? ''
  if (unit) {
    const unitMatch = new RegExp(`^${escapeRegExp(unit)}s?\\.?\\s*`, 'i').exec(rest)
    if (unitMatch) rest = rest.slice(unitMatch[0].length)
  }

  return { id: line.id, amount, unit, tail: rest.trim(), sectionHeading: line.sectionHeading }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `1 1/2` → 1.5, so the scaled view has a number to work with. Null when it isn't one. */
function parseAmount(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(trimmed)
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3])
  const fraction = /^(\d+)\/(\d+)$/.exec(trimmed)
  if (fraction) return Number(fraction[1]) / Number(fraction[2])
  const decimal = Number(trimmed.replace(',', '.'))
  return Number.isFinite(decimal) ? decimal : null
}

/**
 * Rebuild the save payload.
 *
 * `rawText` is recomposed from the edited amount, the unit and **the original tail** — so the
 * source's wording survives an edit that only ever meant to change a number. `sourceUrl` and
 * `importMethod` are not sent at all, which is what keeps provenance intact through the round trip.
 */
function buildInput(
  recipe: RecipeDto, title: string, lines: Draft[], servings: number | null, editor: number | null,
) {
  const ingredients: RecipeIngredientInput[] = lines
    .filter((l) => l.amount.trim() || l.unit.trim() || l.tail.trim())
    .map((l) => ({
      rawText: [l.amount.trim(), l.unit.trim(), l.tail.trim()].filter(Boolean).join(' '),
      // Setting an amount is what makes a line scale — the rule line under the form says so, and
      // this is where it becomes true.
      quantity: parseAmount(l.amount),
      unit: l.unit.trim() || null,
      sectionHeading: l.sectionHeading,
    }))

  return {
    // The one field on this form that is a replace rather than a repair. Falls back to the stored
    // title rather than sending an empty one: the callers already refuse a blank name, and a PUT
    // that 400s after the amounts were typed is a worse failure than an unchanged name.
    title: title.trim() || recipe.title,
    description: recipe.description,
    sourceUrl: recipe.sourceUrl,
    sourceName: recipe.sourceName,
    servings,
    yieldText: recipe.yieldText,
    prepMinutes: recipe.prepMinutes,
    cookMinutes: recipe.cookMinutes,
    totalMinutes: recipe.totalMinutes,
    ingredients,
    steps: recipe.steps.map((s) => ({ text: s.text, sectionHeading: s.sectionHeading })),
    tags: recipe.tags,
    isArchived: recipe.isArchived,
    leadMinutes: recipe.leadMinutes,
    prepNote: recipe.prepNote,
    modifiedByProfileId: editor,
  }
}

/** Lines whose amount or unit disagrees with the server's copy. */
function diffLines(mine: Draft[], theirs: RecipeDto): { mine: Draft; their: Draft }[] {
  const byId = new Map(theirs.ingredients.map((i) => [i.id, toDraft(i)]))
  const out: { mine: Draft; their: Draft }[] = []
  for (const line of mine) {
    const their = byId.get(line.id)
    if (!their) continue
    if (their.amount !== line.amount || their.unit !== line.unit) out.push({ mine: line, their })
  }
  return out
}

/** Append a keypad token, keeping the field to something that can still parse. */
function appendAmount(current: string, token: string): string {
  if (token === '.' && current.includes('.')) return current
  // A fraction key replaces whatever fraction is already there rather than concatenating into
  // "1/21/3", which is not a number anyone meant to type.
  if (token.includes('/')) {
    const whole = /^(\d+)/.exec(current)?.[1] ?? ''
    return whole ? `${whole} ${token}` : token
  }
  return current + token
}
