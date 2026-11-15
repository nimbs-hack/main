// Portraits are image files in src/assets/crew, named after the call sign in
// lower case: vega.jpg for VEGA. Vite lists the folder at build time, so a
// crew member without a file costs no request.
const FILES = import.meta.glob<string>('../assets/crew/*.{jpg,jpeg,png,webp,avif}', {
  eager: true,
  query: '?url',
  import: 'default',
})

const BY_NAME = new Map(
  Object.entries(FILES).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, path.lastIndexOf('.')).toLowerCase(), url]),
)

// True when a photo of this call sign ships with the app.
export const hasPortrait = (name: string): boolean => BY_NAME.has(name.trim().toLowerCase())

// The photo of a crew member: the one added on the crew page, or the file
// that ships with the app, or their first two letters when there is neither.
export function Portrait({ name, photo }: { name: string; photo?: string }) {
  const url = photo ?? BY_NAME.get(name.trim().toLowerCase())
  return url ? (
    <img className="portrait" src={url} alt={`Portrait of ${name}`} />
  ) : (
    <span className="portrait portrait--none" title="No portrait on file" aria-hidden="true">
      {name.trim().slice(0, 2) || '?'}
    </span>
  )
}
