import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ScrollArea } from '../../components'
import { api, ApiError } from '../../api/client'
import { useMeals } from '../../app/MealsProvider'
import { cuisineTag } from '../../app/mealsPrefs'
import { MealAlert, MealsLabel, MealsModal, RuleLine } from './parts'

/**
 * Add a recipe (MEALS_SCREEN §9, id 1h).
 *
 * Two paths, in the order they are actually worth using: paste a link, or paste the recipe itself.
 * The phone is named at the foot because it is the fastest route of all and the one people forget
 * exists.
 *
 * **The second path is not "type it in" any more.** It runs the block through the server's paste
 * parser, which uses the same ingredient parser a link import does — so a pasted recipe scales.
 * That matters because the link path cannot read every publisher: allrecipes, Serious Eats and
 * Simply Recipes all answer 402 to any client, browser user-agent included. The household reads the
 * page in their own browser and copies it; nothing here goes around anyone's access decision.
 */
export function AddRecipeScreen() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { refresh, settings, updateSettings } = useMeals()

  const [url, setUrl] = useState('')
  /**
   * What to call it — sent on every path, and overriding whatever the importer read.
   *
   * Pre-filled when this was reached from "Save 'Pizza night' as a recipe" on the assign modal.
   */
  const [title, setTitle] = useState(params.get('title') ?? '')
  const [linesText, setLinesText] = useState('')
  /**
   * The cuisine, as typed.
   *
   * One field rather than a grid of chips. The household's list is the whole reason the folder can
   * group by cuisine at all ("Italy" and "italian" must not become two groups), so it is still the
   * thing being offered — but offered as you type, underneath the box, instead of as twelve buttons
   * that push the recipe itself off the screen. Whatever is left in the box is the answer: pick one
   * of theirs, or keep typing and the new name is the cuisine.
   *
   * A name they have not used before is *remembered* — it joins the canonical list on save, so the
   * next Korean recipe completes from one keystroke and the folder groups both under one spelling.
   * That is what the settings screen's ＋ NEW field does, offered where the question comes up.
   */
  const [cuisineText, setCuisineText] = useState('')
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  /** What the clipboard did, when it did not simply work. */
  const [pasteNote, setPasteNote] = useState<string | null>(null)
  /** Set once somebody chooses to type instead, so the paste panel stops covering the box. */
  const [typing, setTyping] = useState(false)
  const blockRef = useRef<HTMLTextAreaElement>(null)

  /**
   * Read the clipboard into the box.
   *
   * **The panel has no other way to paste.** It is a wall-mounted touchscreen with no physical
   * keyboard, and the on-screen keyboard has no paste key — so `Ctrl+V` is not an option and neither
   * is a long-press menu in kiosk Chromium. Without this, "paste the recipe" is an instruction the
   * hardware cannot follow.
   *
   * Requires a secure context, which the panel has (`deploy/dev-https.md`, and TLS in prod). The
   * first read prompts for permission; every failure below says what happened rather than leaving a
   * button that appears to do nothing.
   */
  const pasteFromClipboard = async () => {
    setPasteNote(null)
    setImportError(null)
    const clipboard = navigator.clipboard
    if (!clipboard?.readText) {
      setTyping(true)
      setPasteNote('This browser will not hand the panel its clipboard. Paste with the keyboard instead.')
      return
    }
    try {
      const text = await clipboard.readText()
      if (!text.trim()) {
        setPasteNote('Nothing on the clipboard yet — copy the recipe off the page first.')
        return
      }
      // Appended, never replaced: a second tap after copying the method should not throw away the
      // ingredients that came from the first.
      setLinesText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${text.trim()}` : text.trim()))
      setTyping(true)
    } catch {
      setTyping(true)
      setPasteNote('The panel was not allowed to read the clipboard. Allow it when the browser asks, or type it in.')
    }
  }

  /**
   * The site a pasted link points at, for the recipe's attribution line ("SERIOUS EATS").
   *
   * Derived from the host rather than asked for: nobody types a source name, and the host is the
   * one part of a recipe URL that reliably identifies where it came from. Null while the field
   * holds something that isn't a URL yet — half-typed text is not a source.
   */
  const sourceName = useMemo(() => hostLabel(url), [url])

  /**
   * The cuisine this recipe is being saved with — whatever is in the box, in the household's
   * spelling where they already have one.
   *
   * Matched on {@link cuisineTag} rather than lowercase, because that is the key the folder actually
   * groups by: someone who types `middle eastern` over their own `Middle Eastern` has not named a
   * second cuisine, and saving their spelling is what keeps it from looking like they did. An empty
   * box is no cuisine — the UNCATEGORISED case, not an error.
   */
  const chosenCuisine = useMemo(() => {
    const typed = cuisineText.trim()
    if (!typed) return null
    return settings.canonicalCuisines.find((c) => cuisineTag(c) === cuisineTag(typed)) ?? typed
  }, [cuisineText, settings.canonicalCuisines])

  /**
   * Keep a cuisine the household has not used before, so it completes next time and the folder
   * groups every recipe that uses it under one spelling.
   *
   * Called on the way out of a *successful* save only. A name added by a form somebody abandoned
   * would be a household setting nobody chose.
   */
  const rememberCuisine = () => {
    if (!chosenCuisine) return
    if (settings.canonicalCuisines.some((c) => cuisineTag(c) === cuisineTag(chosenCuisine))) return
    updateSettings({ canonicalCuisines: [...settings.canonicalCuisines, chosenCuisine] })
  }

  const close = () => navigate(-1)

  /**
   * Read the recipe off the page.
   *
   * Three outcomes, and all three land somewhere useful (D10). `Complete` and `Partial` both wrote a
   * recipe, so both go straight to it — a partial one arrives on a screen that already has the
   * `NO STEPS` treatment and an `OPEN SOURCE` control, which is a better place to finish it than a
   * form. `Empty` wrote nothing and says why.
   *
   * On a refusal it hands off rather than dead-ending: the paste box opens with the link kept, so
   * the next step is copying the page rather than retyping an address. The link the panel could not
   * read is still the recipe's provenance, and the paste path uses it for exactly that.
   */
  const runImport = async () => {
    const link = url.trim()
    if (!link || importing) return
    setImporting(true)
    setImportError(null)
    setPasteNote(null)
    try {
      const result = await api.importRecipe({
        url: link,
        // The name field sits above both paths and applies to both. A publisher's title is a
        // headline as often as a name, so whatever was typed wins over what the page calls itself.
        title: title.trim() || null,
      })
      if (result.confidence === 'Empty' || !result.recipe) {
        setImportError(result.reason ?? "That page doesn't publish recipe data the panel can read.")
        // Open the box and put the cursor where the answer is. `typing` is left alone so the
        // tap-to-paste panel stays up — the clipboard is still the fastest way in.
        blockRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
      await refresh()
      navigate(`/meals/recipes/${result.recipe.id}`, { replace: true })
    } catch (err) {
      setImportError(err instanceof ApiError && err.message ? err.message : 'Could not reach that site.')
    } finally {
      setImporting(false)
    }
  }

  /**
   * Save what was pasted or typed.
   *
   * The block goes through the server's paste parser first, which runs every ingredient line through
   * the same parser a link import uses — so a pasted recipe **scales**, where the raw save below
   * leaves every line as written and scaling does nothing. That is the whole reason this path
   * exists: the publishers that refuse the fetcher (allrecipes and its siblings answer 402 to any
   * client) can still be copied out of the browser by hand.
   *
   * If the parser cannot make a recipe of it, this falls through to the raw save rather than
   * refusing — whatever was typed is still worth keeping, and that is exactly what this screen did
   * before the parser existed.
   */
  const save = async () => {
    const block = linesText.trim()
    const name = title.trim()
    if ((!name && !block) || saving) return
    setSaving(true)
    setImportError(null)
    try {
      if (block) {
        const result = await api.importRecipeText({
          text: block,
          // Kept for attribution, never fetched — that is what makes this work at all.
          sourceUrl: url.trim() || null,
          title: name || null,
          tags: chosenCuisine ? [cuisineTag(chosenCuisine)] : [],
        })
        if (result.confidence !== 'Empty' && result.recipe) {
          rememberCuisine()
          await refresh()
          navigate(`/meals/recipes/${result.recipe.id}`, { replace: true })
          return
        }
        // Not readable as a recipe. Keep going: the raw save below loses the amounts but loses
        // nothing else, which beats handing back an error and an empty screen.
      }
      if (!name) {
        setImportError("Give it a name and the panel will keep it, even if it can't read the amounts.")
        return
      }
      await createRaw(name)
    } finally {
      setSaving(false)
    }
  }

  /** The original save: every line exactly as typed, with no amounts. The fallback, now. */
  const createRaw = async (name: string) => {
    const created = await api.createRecipe({
      title: name,
      // The link is kept as provenance: `sourceUrl` and `sourceName` drive the detail screen's meta
      // line and its OPEN SOURCE control, so a title-plus-link recipe is immediately useful.
      sourceUrl: url.trim() || null,
      sourceName,
      // Every line as typed. Nothing is parsed on this path — it is what runs when the parser could
      // not read the block, and a wrong amount would be worse than no amount.
      ingredients: linesText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((rawText) => ({ rawText })),
      tags: chosenCuisine ? [cuisineTag(chosenCuisine)] : [],
    })
    rememberCuisine()
    await refresh()
    navigate(`/meals/recipes/${created.id}`, { replace: true })
  }

  return (
    <MealsModal
      title="ADD A RECIPE"
      onCancel={close}
      confirm={
        // Enabled on a name *or* a block: a paste carries its own title most of the time, and
        // demanding one before the parser has looked would be asking for what it already knows.
        <button
          type="button"
          className="ml-edit__save"
          disabled={(!title.trim() && !linesText.trim()) || saving}
          onClick={() => void save()}
        >
          {saving ? 'READING…' : 'SAVE'}
        </button>
      }
    >
      <ScrollArea>
        {/*
          The name, above both paths and belonging to both.

          It used to sit under OR PASTE THE RECIPE, which made it look like the paste path's field —
          and the link importer did not send it, so a name typed before tapping IMPORT was silently
          dropped in favour of whatever the publisher put in their `<h1>`. That is worth a field of
          its own: "Our Best-Ever Weeknight Chili (Really!)" is a headline, and the folder is browsed
          by the name somebody would actually say out loud.

          Optional, and said so. Both importers bring a name back and most of the time it is fine.
        */}
        <MealsLabel label="NAME" status="OPTIONAL" />
        <input
          className="ml-add__field"
          value={title}
          placeholder="Leave it and the panel keeps the recipe's own name"
          aria-label="Recipe name"
          maxLength={300}
          onChange={(e) => setTitle(e.target.value)}
        />
        <RuleLine>A NAME TYPED HERE WINS OVER THE ONE ON THE PAGE · RENAME IT LATER FROM EDIT</RuleLine>

        <div className="ml-add__grouprule" aria-hidden="true" />

        <MealsLabel label="PASTE A LINK" status={sourceName ? sourceName.toUpperCase() : undefined} />
        <div className="ml-add__urlrow">
          <input
            className="ml-add__url mono"
            value={url}
            placeholder="https://"
            aria-label="Recipe link"
            onChange={(e) => { setUrl(e.target.value); setImportError(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') void runImport() }}
          />
          <button
            type="button"
            className="ml-add__import"
            disabled={!url.trim() || importing}
            onClick={() => void runImport()}
          >
            {importing ? 'READING…' : 'IMPORT'}
          </button>
        </div>

        {/* The server fetches the page, so this is seconds, not milliseconds. Saying what it is
            doing beats a spinner that could equally mean "hung". */}
        {importing && <p className="ml-add__linknote">Reading {sourceName ?? 'the page'}…</p>}

        {/* A page that publishes no recipe data is not an error — the request worked, the page just
            had nothing in it. Said plainly, with the manual path still right there below. */}
        {/* The action is the way out, not an acknowledgement. A link the panel cannot read is a
            recipe you can still copy off the page, so the button does that rather than saying OK. */}
        {importError && !importing && (
          <MealAlert
            sentence={importError}
            action={
              <button
                type="button"
                className="ml-mealalert__action"
                onClick={() => { setImportError(null); void pasteFromClipboard() }}
              >
                PASTE IT
              </button>
            }
          />
        )}

        {!importing && !importError && (
          <p className="ml-add__linknote">
            {url.trim()
              ? 'IMPORT reads the page and fills this in. If it can\'t, the link is still kept with the recipe.'
              : 'Paste a link and the panel will read the recipe off the page.'}
          </p>
        )}
        <RuleLine>SCHEMA.ORG RECIPE DATA ONLY · PAYWALLED PAGES IMPORT WHAT THEY SHOW</RuleLine>

        <MealsLabel label="CUISINE" />
        <CuisineField value={cuisineText} options={settings.canonicalCuisines} onChange={setCuisineText} />
        {/* The spec's line credits the importer with guessing this, which is true from M2 onward and
            a lie today — there is nothing doing any guessing. Says what the field actually does now;
            the importer's version of the sentence lands with the importer. */}
        <RuleLine>ONE CUISINE EACH · A NEW NAME IS KEPT FOR NEXT TIME · THIS IS WHAT THE FOLDER GROUPS BY</RuleLine>

        <div className="ml-add__grouprule" aria-hidden="true" />

        <MealsLabel label="OR PASTE THE RECIPE" status="AMOUNTS AND STEPS ARE READ" />
        {/*
          The box, with a tap-to-paste panel over it while it is empty.

          On the panel there is no other way in: no physical keyboard, no paste key on the on-screen
          one, and no long-press menu in kiosk Chromium. A plain textarea is a box you cannot fill.
          So the empty state is a button — tapping the area asks the clipboard — with typing one tap
          behind it for the rare recipe somebody enters by hand.
        */}
        <div className="ml-add__pastewrap">
          <textarea
            ref={blockRef}
            className="ml-add__field ml-add__field--lines"
            value={linesText}
            placeholder={'2 tbsp chili powder\n1 tsp cumin\n\nCombine in a small bowl and mix well.'}
            aria-label="The recipe: ingredients and method"
            rows={10}
            onChange={(e) => { setLinesText(e.target.value); setImportError(null); setPasteNote(null) }}
          />
          {!linesText.trim() && !typing && (
            <div className="ml-add__pasteover">
              <button type="button" className="ml-add__pastebtn" onClick={() => void pasteFromClipboard()}>
                TAP TO PASTE THE RECIPE
              </button>
              <span className="ml-add__pastehint">Copy it off the page first — ingredients and method</span>
              <button
                type="button"
                className="ml-add__pastetype"
                onClick={() => { setTyping(true); window.setTimeout(() => blockRef.current?.focus(), 0) }}
              >
                or type it in
              </button>
            </div>
          )}
        </div>

        {/* Offered again once there is content, because a recipe is usually two copies — the
            ingredients, then the method — and the panel it replaced is gone by then. */}
        {(linesText.trim().length > 0 || typing) && (
          <button type="button" className="ml-add__pasteagain" onClick={() => void pasteFromClipboard()}>
            ＋ PASTE FROM THE CLIPBOARD
          </button>
        )}

        {pasteNote && <p className="ml-add__linknote">{pasteNote}</p>}

        {/* Two rule lines used to close this screen: one restating that copying off the page is how
            the amounts get read, and one naming the panel's LAN address as the faster route from a
            phone. Both are gone deliberately. The paste panel above already says "copy it off the
            page first" at the moment it is being asked for, and the phone line answered a question
            nobody asks while holding a phone — which, increasingly, is the device this screen is
            actually being used on. */}
      </ScrollArea>
    </MealsModal>
  )
}

/**
 * The cuisine field: one box that offers the household's list as you type, and takes a new name when
 * none of them is the answer.
 *
 * **The box's text is the cuisine — always.** Tapping a suggestion writes that spelling into the box
 * rather than latching some selection beside it, so there is never a highlighted row saying one thing
 * while the field says another. Nothing is auto-highlighted for the same reason: `ITA` half-typed
 * with `ITALIAN` glowing underneath would save `ITA`, which is exactly the trap a chip grid does not
 * have and a combobox has to earn its way out of.
 *
 * Focus opens the list unfiltered, because the wall panel's first move is a tap, not a keystroke —
 * without that this reads as a field you must already know the answer to, which is worse than the
 * twelve chips it replaces.
 */
function CuisineField({
  value,
  options,
  onChange,
}: {
  value: string
  options: string[]
  onChange: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  /** The keyboard's position in the list. -1 is "nothing picked", which is the state it starts in. */
  const [active, setActive] = useState(-1)
  const wrapRef = useRef<HTMLDivElement>(null)

  const typed = value.trim()

  /**
   * The household's cuisines that match what has been typed, the ones that *start* with it first.
   *
   * Substring rather than prefix-only so `east` still finds `Middle Eastern` — a cuisine people
   * think of by its second word is common enough that prefix matching would look broken.
   */
  const matches = useMemo(() => {
    const q = typed.toLowerCase()
    if (!q) return options
    return options
      .filter((name) => name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.toLowerCase().startsWith(q)) - Number(a.toLowerCase().startsWith(q)))
  }, [options, typed])

  /**
   * Whether the last row is the "this is a new one" row.
   *
   * Compared on {@link cuisineTag} so retyping `middle-eastern` over their `Middle Eastern` is not
   * offered as a new cuisine — it is the same tag, and saying otherwise would invite two spellings
   * of one group, which is the thing the canonical list exists to prevent.
   */
  const isNew = typed.length > 0 && !options.some((c) => cuisineTag(c) === cuisineTag(typed))
  const rows: ({ kind: 'known'; name: string } | { kind: 'new'; name: string })[] = [
    ...matches.map((name) => ({ kind: 'known' as const, name })),
    ...(isNew ? [{ kind: 'new' as const, name: typed }] : []),
  ]

  const choose = (name: string) => {
    onChange(name)
    setOpen(false)
    setActive(-1)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false)
      setActive(-1)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      if (rows.length === 0) return
      // Cycles through the rows *and* back out to -1, so arrowing past the end returns to whatever
      // was typed rather than trapping the choice inside the list.
      const step = e.key === 'ArrowDown' ? 1 : -1
      const slots = rows.length + 1
      setActive((i) => ((i + 1 + step + slots) % slots) - 1)
      return
    }
    if (e.key === 'Enter') {
      // Never let Enter reach the form: on a screen whose other control is SAVE, a stray submit
      // while the list is open would file the recipe from under the person still choosing.
      e.preventDefault()
      if (open && active >= 0 && active < rows.length) choose(rows[active].name)
      else setOpen(false)
    }
  }

  return (
    <div
      className="ml-add__combo"
      ref={wrapRef}
      onBlur={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <input
        className="ml-add__field ml-add__combofield"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? 'cuisine-options' : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `cuisine-option-${active}` : undefined}
        aria-label="Cuisine"
        value={value}
        placeholder="Italian, Thai, Korean…"
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(-1) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && rows.length > 0 && (
        <div className="ml-add__combolist" id="cuisine-options" role="listbox" aria-label="Cuisines">
          {rows.map((row, i) => (
            <button
              key={`${row.kind}:${row.name}`}
              id={`cuisine-option-${i}`}
              type="button"
              role="option"
              aria-selected={i === active}
              className={
                'ml-add__combooption'
                + (i === active ? ' ml-add__combooption--active' : '')
                + (row.kind === 'new' ? ' ml-add__combooption--new' : '')
              }
              // Keeps focus in the box, so the tap lands as a choice rather than as a blur that
              // closes the list out from under the finger.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(row.name)}
            >
              <span>{row.name.toUpperCase()}</span>
              {row.kind === 'new' && <span className="ml-add__combonew">＋ NEW</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * `https://www.seriouseats.com/thai-green-curry` → `Serious Eats`.
 *
 * Best-effort and deliberately conservative: the bare host with `www.` and the TLD dropped, spaced
 * on hyphens and title-cased. Anything that doesn't parse as a URL returns null rather than a
 * guess, because a wrong attribution on a recipe is worse than none.
 */
function hostLabel(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  try {
    const host = new URL(text.includes('://') ? text : `https://${text}`).hostname.replace(/^www\./, '')
    const name = host.split('.').slice(0, -1).join(' ')
    if (!name) return null
    return name
      .split(/[-\s]+/)
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(' ')
  } catch {
    return null
  }
}
