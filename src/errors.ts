/**
 * PhotonError — structured error for Photon rendering.
 */
export class PhotonError extends Error {
  readonly code: string
  readonly hint?: string

  constructor(code: string, message: string, options?: { hint?: string }) {
    super(message)
    this.name = 'PhotonError'
    this.code = `PHOTON_${code}`
    this.hint = options?.hint
  }
}
