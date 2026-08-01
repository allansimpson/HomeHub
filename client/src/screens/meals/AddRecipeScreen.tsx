import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ScrollArea } from '../../components'
import { api, ApiError } from '../../api/client'
import { useSession } from '../../app/SessionProvider'
import { useMeals } from '../../app/MealsProvider'
import { cuisineTag } from '../../app/mealsPrefs'
import { panelAddress } from '../../app/mealsDomain'
import { MealAlert, MealsLabel, MealsModal, RuleLine } from './parts'

/**
 * Add a recipe (MEALS_SCREEN §9, id 1h).
 *
 * Two paths, in the order they are actually worth using: paste a link, or type it in. The phone is
 * named at the foot because it is the fastest route of all and the one people forget exists.
 *
 * Import progress and its result screens are Stage M2 — this screen ends at `IMPORT`, and says so
 * rather than pretending to parse.
 */
export function AddRecipeScreen() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { activeProfileId } = useSession()
  const { refresh, settings } = useMeals()

  const [url, setUrl] = useState('')
  // Pre-filled when this was reached from "Save 'Pizza night' as a recipe" on the assign modal.
  const [title, setTitle] = useState(params.get('title') ?? '')
  const [linesText, setLinesText] = useState('')
  const [cuisine, setCuisine] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  /**
   * The site a pasted link points at, for the recipe's attribution line ("SERIOUS EATS").
   *
   * Derived from the host rather than asked for: nobody types a source name, and the host is the
   * one part of a recipe URL that reliably identifies where it came from. Null while the field
   * holds something that isn't a URL yet — half-typed text is not a source.
   */
  const sourceName = useMemo(() => hostLabel(url), [url])

  const close = () => navigate(-1)

  /**
   * Read the recipe off the page.
   *
   * Three outcomes, and all three land somewhere useful (D10). `Complete` and `Partial` both wrote a
   * recipe, so both go straight to it — a partial one arrives on a screen that already has the
   * `NO STEPS` treatment and an `OPEN SOURCE` control, which is a better place to finish it than a
   * form. `Empty` wrote nothing and says why, leaving the manual path below untouched and ready.
   */
  const runImport = async () => {
    const link = url.trim()
    if (!link || importing) return
    setImporting(true)
    setImportError(null)
    try {
      const result = await api.importRecipe({ url: link, profileId: activeProfileId })
      if (result.confidence === 'Empty' || !result.recipe) {
        setImportError(result.reason ?? "That page doesn't publish recipe data the panel can read.")
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

  const create = async () => {
    const name = title.trim()
    if (!name || saving) return
    setSaving(true)
    try {
      const created = await api.createRecipe({
        title: name,
        // The pasted link is kept even though nothing reads it yet. `sourceUrl` and `sourceName`
        // already drive the detail screen's meta line and its OPEN SOURCE control, so a
        // title-plus-link recipe is immediately useful — and it is exactly the row the M2 importer
        // will later be able to fill in, rather than a duplicate someone has to reconcile.
        sourceUrl: url.trim() || null,
        sourceName,
        // Every line the person typed, as they typed it. No parsing on the panel: the amount fields
        // on the edit screen are where a line becomes scalable, deliberately and one at a time.
        ingredients: linesText
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((rawText) => ({ rawText })),
        tags: cuisine ? [cuisineTag(cuisine)] : [],
        modifiedByProfileId: activeProfileId,
      })
      await refresh()
      navigate(`/meals/recipes/${created.id}`, { replace: true })
    } finally {
      setSaving(false)
    }
  }

  return (
    <MealsModal
      title="ADD A RECIPE"
      onCancel={close}
      confirm={
        <button type="button" className="ml-edit__save" disabled={!title.trim() || saving} onClick={() => void create()}>
          SAVE
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
        {importError && !importing && (
          <MealAlert sentence={importError} action={
            <button type="button" className="ml-mealalert__action" onClick={() => setImportError(null)}>OK</button>
          } />
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
              className={'ml-add__chip' + (cuisine === name ? ' ml-add__chip--active' : '')}
              onClick={() => setCuisine((c) => (c === name ? null : name))}
            >
              {name.toUpperCase()}
            </button>
          ))}
        </div>
        {/* The spec's line credits the importer with guessing this, which is true from M2 onward and
            a lie today — there is nothing doing any guessing. Says what the chip actually does now;
            the importer's version of the sentence lands with the importer. */}
        <RuleLine>ONE CUISINE EACH · THIS IS WHAT THE FOLDER GROUPS BY</RuleLine>

        <div className="ml-add__grouprule" aria-hidden="true" />

        <MealsLabel label="OR TYPE IT IN" status="TITLE, THEN LINES" />
        <input
          className="ml-add__field"
          value={title}
          placeholder="Recipe name"
          aria-label="Recipe name"
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="ml-add__field ml-add__field--lines"
          value={linesText}
          placeholder="One ingredient per line"
          aria-label="Ingredients, one per line"
          rows={6}
          onChange={(e) => setLinesText(e.target.value)}
        />

        {/* Only claims the phone route when the panel is actually reachable at the address it would
            print. On the real panel `location.host` is the server's LAN address (deploy/pi-kiosk.md)
            and a phone on the same wi-fi can open it; in dev it is `localhost`, which is true for
            nobody but this machine. Printing that would be telling someone to type an address that
            cannot work. */}
        {panelAddress() ? (
          <RuleLine>{`FASTER FROM A PHONE — ${panelAddress()} ON THE SAME WI-FI`}</RuleLine>
        ) : (
          <RuleLine>ADDING FROM A PHONE NEEDS THE PANEL'S OWN ADDRESS — NOT AVAILABLE IN DEV</RuleLine>
        )}
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
