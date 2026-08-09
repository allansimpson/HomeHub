import { LedgerRow, ScrollArea } from 'client'

/**
 * A list longer than its region, so the bottom fade and the brass position tick both show —
 * two of the three scrollability signals. A short list would prove nothing.
 */
export const Default = () => (
  <div style={{ height: '11rem' }}>
    <ScrollArea>
      {['Living Room', 'Nursery', 'Main Bedroom', 'Office', 'Kitchen', 'Garage', 'Basement', 'Back Porch'].map(
        (room, i) => (
          <LedgerRow key={room} title={room} sub={`Updated ${i + 1} min ago`} right={<span className="serif">{68 + i}°</span>} />
        ),
      )}
    </ScrollArea>
  </div>
)

/** With the optional caption — the third signal, for when the fade alone is too subtle. */
export const WithCaption = () => (
  <div style={{ height: '11rem' }}>
    <ScrollArea caption="Scroll for evening ▾">
      {['6:00 AM', '8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM', '4:00 PM', '6:00 PM', '8:00 PM'].map((t, i) => (
        <LedgerRow key={t} title={t} right={<span className="serif">{64 + i}°</span>} />
      ))}
    </ScrollArea>
  </div>
)
