import { Chip, LedgerRow } from 'client'

/** The base row: a title, a supporting line, and a right-hand value. */
export const Default = () => (
  <LedgerRow title="Living Room" sub="Probe · updated 2 min ago" right={<span className="serif">71°</span>} />
)

/**
 * Rows are meant to stack — the hairline between them is the whole motif, so a single row in
 * isolation misrepresents the component.
 */
export const Stacked = () => (
  <div>
    <LedgerRow title="Living Room" sub="Holding 71°" right={<span className="serif">71°</span>} />
    <LedgerRow title="Nursery" sub="Warming to 68°" right={<span className="serif">66°</span>} />
    <LedgerRow title="Main Bedroom" sub="Paused" right={<span className="serif">73°</span>} />
    <LedgerRow title="Office" sub="Probe silent 15 min" right={<span className="serif">—</span>} />
  </div>
)

/** `major` draws the heavier hairline that opens a new group within a list. */
export const MajorRule = () => (
  <div>
    <LedgerRow major title="Upstairs" right={<span className="label">3 ROOMS</span>} />
    <LedgerRow title="Nursery" sub="Warming to 68°" right={<span className="serif">66°</span>} />
    <LedgerRow title="Main Bedroom" sub="Holding" right={<span className="serif">73°</span>} />
  </div>
)

/** A row that drills in, with a chip carrying state on the right. */
export const Tappable = () => (
  <div>
    <LedgerRow title="Kitchen" sub="Sensibo · mini-split" right={<Chip label="LIVE" live active />} onClick={() => {}} />
    <LedgerRow title="Garage" sub="Unreachable 30 min" right={<Chip label="FAULT" active />} onClick={() => {}} />
  </div>
)

/** `children` takes over the row body entirely when the title/sub split doesn't fit. */
export const CustomBody = () => (
  <LedgerRow right={<span className="serif">18:42</span>}>
    <span className="label">LAST CLEAN CYCLE</span>
  </LedgerRow>
)
