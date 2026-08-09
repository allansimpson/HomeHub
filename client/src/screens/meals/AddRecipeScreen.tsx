import { useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ScrollArea } from '../../components'
import { api, ApiError } from '../../api/client'
import { useSession } from '../../app/SessionProvider'
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
  const { activeProfileId } = useSession()
  const { refresh, settings, updateSettings } = useMeals()

  const [url, setUrl] = useState('')
  // Pre-filled when this was reached from "Save 'Pizza night' as a recipe" on the assign modal.
  const [title, setTitle] = useState(params.get('title') ?? '')
  const [linesText, setLinesText] = useState('')
  const [cuisine, setCuisine] = useState<string | null>(null)
  /**
   * OTHER — a cuisine the household's list does not have yet.
   *
   * The chips are the canonical spellings, and that list is the whole reason the folder can group by
   * cuisine at all ("Italy" and "italian" must not become two groups). But a fixed list of twelve is
   * a wall as soon as somebody cooks Korean: without this the only way in was Config → Meals →
   * CUISINES, three screens away from the recipe you are holding.
   *
   * What is typed here is *remembered* — it joins the canonical list on save, so the next Korean
   * recipe is a chip rather than a second round of typing, and the folder groups both under one
   * spelling. That is the same thing the settings screen's ＋ NEW field does, offered where the
   * question actually comes up.
   */
  const [otherCuisine, setOtherCuisine] = useState('')
  const [otherOpen, setOtherOpen] = useState(false)
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

  /** The cuisine this recipe is being saved with — a chip, or whatever OTHER has been typed into. */
  const chosenCuisine = otherOpen ? otherCuisine.trim() || null : cuisine

  /**
   * Keep a cuisine typed into OTHER, so it is a chip next time and the folder groups by one spelling.
   *
   * Called on the way out of a *successful* save only. A name added by a form somebody abandoned
   * would be a household setting nobody chose.
   */
  const rememberCuisine = () => {
    if (!otherOpen || !chosenCuisine) return
    if (settings.canonicalCuisines.some((c) => c.toLowerCase() === chosenCuisine.toLowerCase())) return
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
      const result = await api.importRecipe({ url: link, profileId: activeProfileId })
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
          profileId: activeProfileId,
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
      modifiedByProfileId: activeProfileId,
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
        <div className="ml-add__chips">
          {settings.canonicalCuisines.map((name) => (
            <button
              key={name}
              type="button"
              className={'ml-add__chip' + (!otherOpen && cuisine === name ? ' ml-add__chip--active' : '')}
              onClick={() => { setOtherOpen(false); setCuisine((c) => (c === name ? null : name)) }}
            >
              {name.toUpperCase()}
            </button>
          ))}
          {/* Last, and a toggle rather than a separate control: OTHER is one of the cuisine choices,
              not an escape hatch beside them. Choosing it clears any chip, because a recipe carries
              one cuisine and two highlighted answers would not say which. */}
          <button
            type="button"
            className={'ml-add__chip' + (otherOpen ? ' ml-add__chip--active' : '')}
            onClick={() => { setOtherOpen((open) => !open); setCuisine(null) }}
          >
            OTHER
          </button>
          {otherOpen && (
            <input
              className="ml-add__otherchip"
              value={otherCuisine}
              placeholder="TYPE ONE"
              aria-label="Cuisine"
              onChange={(e) => setOtherCuisine(e.target.value)}
            />
          )}
        </div>
        {/* The spec's line credits the importer with guessing this, which is true from M2 onward and
            a lie today — there is nothing doing any guessing. Says what the chip actually does now;
            the importer's version of the sentence lands with the importer. */}
        <RuleLine>ONE CUISINE EACH · THIS IS WHAT THE FOLDER GROUPS BY</RuleLine>

        <div className="ml-add__grouprule" aria-hidden="true" />

        <MealsLabel label="OR PASTE THE RECIPE" status="AMOUNTS AND STEPS ARE READ" />
        <input
          className="ml-add__field"
          value={title}
          placeholder="Recipe name — or leave it, the paste usually says"
          aria-label="Recipe name"
          onChange={(e) => setTitle(e.target.value)}
        />
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
