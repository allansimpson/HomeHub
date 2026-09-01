import { useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { KitchenDivider, KitchenDrillInHeader, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import { AttachmentRefused, readAttachment } from '../assist/attachments'
import type { ReadLineDto, RecipeReadingDto } from '../../api/types'

/** The three routes under the viewfinder, in the order R3 lists them. */
type StartFrom = 'link' | 'type' | 'paste'

/**
 * ADDING ONE (RECIPES §3, panel R3).
 *
 * A full-page errand with no chrome, matching the add-to-pantry errand exactly: `CANCEL` in the
 * header, and one button that commits.
 *
 * **Photo capture is the lead route, not one option among four.** Cookbook pages, handwritten
 * cards and phone screenshots are where most of a household's recipes actually live — so the
 * viewfinder is the top of the page and the link box is beneath it, which is the reverse of what
 * a recipe app usually does and the right way round for this household.
 *
 * **Nothing blocks the save.** Unclear lines are counted and named and then left alone; the button
 * says `SAVE IT ROUGH` so nothing pretends to be finished. There is no review panel and no capture
 * queue — a recipe that is 90% right in the folder beats a perfect one still in a queue.
 */
export function KitchenAddRecipeScreen() {
  const navigate = useNavigate()
  const picker = useRef<HTMLInputElement>(null)

  /**
   * Words handed over from somewhere else — the chat, when it could not read a recipe out of what
   * was said.
   *
   * <b>The box opens with them already in it.</b> The alternative is telling somebody the panel
   * could not read their conversation and then asking them to go back and copy it out themselves,
   * which is the panel handing back the work it has just failed at.
   */
  const handoff = (useLocation().state as { text?: string } | null)?.text?.trim()

  const [reading, setReading] = useState<RecipeReadingDto | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [stage, setStage] = useState<'idle' | 'reading' | 'read'>('idle')
  const [trouble, setTrouble] = useState<string | null>(null)

  const [from, setFrom] = useState<StartFrom | null>(handoff ? 'paste' : null)
  const [link, setLink] = useState('')
  const [text, setText] = useState(handoff ?? '')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const read = async (file: File) => {
    setTrouble(null)
    setStage('reading')
    try {
      const attachment = await readAttachment(file)
      if (attachment.base64 == null) {
        setTrouble('That file is not a picture.')
        setStage('idle')
        return
      }
      setPreview(attachment.preview)
      const result = await api.readRecipePhoto({
        imageBase64: attachment.base64,
        mediaType: attachment.mediaType,
      })
      setReading(result)
      setStage(result.ingredients.length > 0 || result.steps.length > 0 ? 'read' : 'idle')
      // The server distinguishes "no reader here" from "nothing on that page"; the panel repeats
      // whichever it was said rather than inventing a third sentence.
      if (result.reason) setTrouble(result.reason)
      if (result.title) setTitle(result.title)
    } catch (e) {
      setTrouble(e instanceof AttachmentRefused ? e.message : 'That one could not be read.')
      setStage('idle')
    }
  }

  /** Everything that was read, as the text importer wants it — the same parser as every other route. */
  const assemble = (r: RecipeReadingDto): string => [
    r.title,
    r.servings != null ? `Serves ${r.servings}` : null,
    '',
    ...r.ingredients.map((l) => l.rawText),
    '',
    ...r.steps.map((l) => l.rawText),
  ].filter((l) => l != null).join('\n')

  const save = async () => {
    setBusy(true)
    try {
      const response = from === 'link' && link.trim()
        ? await api.importRecipe({ url: link.trim(), title: title.trim() || null })
        : await api.importRecipeText({
          text: reading ? assemble(reading) : text,
          title: title.trim() || null,
        })

      if (response.recipe) navigate(`/kitchen/recipes/${response.recipe.id}`)
      else setTrouble(response.reason ?? 'Nothing could be read out of that.')
    } finally {
      setBusy(false)
    }
  }

  const readable = reading != null && (reading.ingredients.length > 0 || reading.steps.length > 0)
  const canSave = readable || link.trim().length > 0 || text.trim().length > 0

  return (
    <ScreenShell
      nav={false}
      header={
        <KitchenDrillInHeader
          title="Add a recipe"
          onExit={() => navigate('/kitchen/recipes')}
          exit="CANCEL"
        />
      }
    >
      <ScrollArea>
        {/*
          The viewfinder, dormant until tapped. Top of the page because a photograph is where the
          recipe actually is — not because photography is the fanciest of the four routes.
        */}
        <button
          type="button"
          className="ml-kitchen__viewfinder"
          onClick={() => picker.current?.click()}
          disabled={stage === 'reading'}
        >
          {preview
            ? <img className="ml-kitchen__vfshot" src={preview} alt="" />
            : (
              <>
                <span className="ml-kitchen__vfcorner ml-kitchen__vfcorner--tl" />
                <span className="ml-kitchen__vfcorner ml-kitchen__vfcorner--tr" />
                <span className="ml-kitchen__vfcorner ml-kitchen__vfcorner--bl" />
                <span className="ml-kitchen__vfcorner ml-kitchen__vfcorner--br" />
              </>
            )}
          <span className="ml-kitchen__vflabel">
            {stage === 'reading' ? 'READING IT…' : 'TAP TO PHOTOGRAPH A RECIPE'}
          </span>
        </button>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void read(file)
            e.target.value = ''
          }}
        />

        {trouble && <div className="ml-kitchen__askwhy">{trouble}</div>}

        {readable && reading && (
          <>
            <KitchenDivider label="Read from the photo" count="EDITABLE" amber gap={false} />
            <div>
              <div className="ml-kitchen__field">
                <span className="ml-kitchen__fieldlabel">NAME</span>
                <input
                  className="ml-kitchen__input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div className="ml-kitchen__askwhy">
                {reading.servings != null && `Serves ${reading.servings}. `}
                {reading.ingredients.length + reading.steps.length} lines
                {reading.unclearCount > 0 && ` · ${reading.unclearCount} unclear`}
              </div>
              {/* The lines themselves, verbatim. Unclear ones are tagged and kept — the editor is
                  where they get fixed, which was the whole instruction behind dropping the review
                  panel. */}
              {/* 40px parsed lines — the shortest rows in the section, and the group cuts on
                  their own height (RECIPES §6). */}
              <div>
                {[...reading.ingredients, ...reading.steps].map((line, i) => (
                  <ParsedLine key={`${i}-${line.rawText}`} line={line} />
                ))}
              </div>
            </div>
          </>
        )}

        <KitchenDivider label="Or start from" />
        <div>
          <div className="ml-kitchen__errandrow">
            <button
              type="button"
              className={'ml-kitchen__errandalt ml-kitchen__errandalt--source' + (from === 'link' ? ' ml-kitchen__chip--on' : '')}
              onClick={() => setFrom('link')}
            >
              A link
            </button>
            <button
              type="button"
              className={'ml-kitchen__errandalt ml-kitchen__errandalt--source' + (from === 'type' ? ' ml-kitchen__chip--on' : '')}
              onClick={() => setFrom('type')}
            >
              Typing it in
            </button>
            <button
              type="button"
              className={'ml-kitchen__errandalt ml-kitchen__errandalt--source' + (from === 'paste' ? ' ml-kitchen__chip--on' : '')}
              onClick={() => setFrom('paste')}
            >
              Pasting text
            </button>
          </div>

          {from === 'link' && (
            <div className="ml-kitchen__field">
              <span className="ml-kitchen__fieldlabel">WHERE IT IS</span>
              <input
                className="ml-kitchen__input"
                value={link}
                placeholder="https://"
                onChange={(e) => setLink(e.target.value)}
              />
            </div>
          )}

          {(from === 'type' || from === 'paste') && (
            <div className="ml-kitchen__field">
              <span className="ml-kitchen__fieldlabel">
                {from === 'type' ? 'WRITE IT OUT' : 'PASTE IT IN'}
              </span>
              <textarea
                className="ml-kitchen__input ml-kitchen__textarea"
                value={text}
                rows={8}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="ml-kitchen__errandactions">
        {/* Says what it is. A button reading SAVE would be claiming the recipe is finished. */}
        <button
          type="button"
          className="ml-kitchen__shop"
          disabled={busy || !canSave}
          onClick={save}
        >
          SAVE IT ROUGH
        </button>
      </div>
    </ScreenShell>
  )
}

function ParsedLine({ line }: { line: ReadLineDto }) {
  return (
    <div className={'ml-row ml-kitchen__parsed' + (line.unclear ? ' ml-kitchen__parsed--unclear' : '')}>
      <span className="ml-kitchen__parsedtext">{line.rawText}</span>
      {line.unclear && <span className="ml-kitchen__unclear">UNCLEAR</span>}
    </div>
  )
}
