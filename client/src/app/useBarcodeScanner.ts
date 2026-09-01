import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/**
 * Why the viewfinder is empty, when it is.
 *
 * Four states rather than one, because they need different sentences and have different fixes.
 * `no-decoder` is the common case on a desktop browser and on every iPhone: the camera is right
 * there and works, but `BarcodeDetector` is Chromium-only, so telling somebody "no camera here"
 * while their webcam light is on sends them hunting for a hardware fault that does not exist.
 * `insecure` is the one HTTPS fixes, and naming it is what makes the fix discoverable.
 */
export type CameraState = 'idle' | 'starting' | 'live' | 'no-camera' | 'no-decoder' | 'insecure'

interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string; format: string }[]>
}

/** A barcode held in front of the lens decodes on every frame; the same pack counts once. */
const REPEAT_AFTER_MS = 2000

/**
 * The camera half of scanning, shared by the phone's tally screen and the add form's viewfinder.
 *
 * <b>Extracted rather than copied.</b> The two surfaces do opposite things with what they read —
 * one moves stock, the other only fills a form — but the part in between is identical and is the
 * part with the traps in it: the same barcode decodes many times a second, the loop has to be
 * pausable while a question is on screen, the stream has to be handed back on unmount, and the
 * three ways a camera can be unavailable are distinguishable only in a particular order. Written
 * twice, those diverge silently and the second copy is the one nobody tests.
 *
 * @param video    the element the stream is attached to
 * @param onCode   called once per pack — see {@link REPEAT_AFTER_MS}
 * @param options  `active` starts the camera; `paused` holds the loop without dropping the stream
 */
export function useBarcodeScanner(
  video: RefObject<HTMLVideoElement | null>,
  onCode: (barcode: string, format: string | null) => void | Promise<void>,
  { active, paused = false }: { active: boolean; paused?: boolean },
): CameraState {
  const [state, setState] = useState<CameraState>('idle')

  /*
   * The callback and the pause flag live in refs so the effect does not restart on every render.
   *
   * Both change whenever the caller re-renders — which a decoded barcode causes, since it fills a
   * form. Listed as dependencies they would tear the camera down and ask for permission again on
   * the first successful scan, which is the one moment it must not happen.
   */
  const handler = useRef(onCode)
  handler.current = onCode
  const held = useRef(paused)
  held.current = paused

  useEffect(() => {
    if (!active) {
      setState('idle')
      return
    }

    const detectorCtor = (window as unknown as {
      BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike
    }).BarcodeDetector

    // Distinguished in this order because it is the order in which they can be fixed: an insecure
    // origin is a deployment problem with a known answer, a missing decoder is a browser choice
    // nobody here can change, and an absent camera is a device fact.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setState(window.isSecureContext ? 'no-camera' : 'insecure')
      return
    }
    if (!detectorCtor) {
      setState('no-decoder')
      return
    }

    let stream: MediaStream | null = null
    let raf = 0
    let stopped = false
    let lastCode = ''
    let lastAt = 0

    setState('starting')
    const detector = new detectorCtor({ formats: ['upc_a', 'upc_e', 'ean_8', 'ean_13'] })

    const loop = async () => {
      if (stopped || !video.current) return
      // Hold everything while a question is on screen. The frames keep arriving; we simply stop
      // reading them until it has been answered.
      if (held.current) {
        raf = requestAnimationFrame(() => void loop())
        return
      }
      try {
        const hit = (await detector.detect(video.current))[0]
        if (hit && (hit.rawValue !== lastCode || Date.now() - lastAt > REPEAT_AFTER_MS)) {
          lastCode = hit.rawValue
          lastAt = Date.now()
          await handler.current(hit.rawValue, hit.format)
        }
      } catch {
        // A frame that could not be read is normal; keep going.
      }
      if (!stopped) raf = requestAnimationFrame(() => void loop())
    }

    void navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (stopped) { s.getTracks().forEach((t) => t.stop()); return }
        stream = s
        if (video.current) {
          video.current.srcObject = s
          void video.current.play()
        }
        setState('live')
        raf = requestAnimationFrame(() => void loop())
      })
      // Reached when the API exists but the stream does not: permission denied, or no camera on
      // the device. Either way there is nothing here to point at a barcode.
      .catch(() => setState('no-camera'))

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [active, video])

  return state
}

/**
 * What to say when the viewfinder cannot run — one sentence per cause, each naming its own fix.
 *
 * `null` while it is working or not yet asked for.
 */
export function cameraExcuse(state: CameraState): string | null {
  switch (state) {
    case 'insecure':
      return 'The camera needs a secure connection. Open the panel over HTTPS and it will work.'
    case 'no-decoder':
      return 'This browser cannot read barcodes. Chrome and Edge can; Safari cannot. '
        + 'Type it in below instead.'
    case 'no-camera':
      return 'No camera answered. Type it in below instead.'
    default:
      return null
  }
}
